# Module: Loader HDR
> Package path: `packages/babylon-lite/src/loader-hdr/`

## Purpose

Loads Radiance `.hdr` (RGBE) equirectangular panorama files and produces GPU-ready IBL (Image-Based Lighting) textures identical to Babylon.js `HDRCubeTexture`. The pipeline runs in five stages: RGBE parsing (CPU), spherical harmonics extraction (CPU), equirect→cubemap conversion (GPU compute), importance-sampled GGX cubemap prefiltering (GPU compute), and BRDF split-sum LUT generation (GPU compute).

## Public API Surface

### Functions

```typescript
// load-hdr.ts
export async function loadHdrEnvironment(
    scene: SceneContext,
    url: string,
    options?: HdrLoadOptions
): Promise<EnvironmentTextures>;
```

### Types

```typescript
export interface HdrLoadOptions {
    faceSize?: number;              // cubemap face size in pixels (default 256)
    useCubemapSkybox?: boolean;     // render HDR cubemap as skybox background
    skipGround?: boolean;           // skip ground plane renderable
    skyboxSize?: number;            // skybox mesh size (matches BJS createDefaultEnvironment)
}
```

```typescript
// hdr-parser.ts
export interface HdrImage {
    width: number;
    height: number;
    data: Float32Array;             // Float32 RGB (3 floats per pixel, row-major)
}

export function parseRGBE(buffer: ArrayBuffer): HdrImage;

export function computeSHFromEquirect(
    data: Float32Array,
    width: number,
    height: number
): Float32Array;                    // 27 floats: SphericalPolynomial coefficients
```

```typescript
// hdr-ibl-pipeline.ts
export function equirectToCubemapGPU(device: GPUDevice, hdr: HdrImage, faceSize: number): GPUTexture;
export function prefilterCubemapGPU(device: GPUDevice, srcCube: GPUTexture, faceSize: number, mipCount: number): GPUTexture;
export function generateBrdfLut(device: GPUDevice): GPUTexture;
```

## Internal Architecture

### Stage 1: RGBE Parsing — `parseRGBE()`

Decodes Radiance `.hdr` files:

1. **Header parsing**: Read `#?` signature line, then key-value pairs until empty line. Extract `FORMAT=32-bit_rle_rgbe`.
2. **Resolution**: Parse `-Y height +X width` line.
3. **Scanline decoding**: For each row, call `decodeScanline()`:
   - **New-style RLE** (if `width ∈ [8, 0x7FFF]` and first 4 bytes are `[2, 2, width_hi, width_lo]`):
     - 4 channel passes (R, G, B, E), each RLE-compressed
     - Run byte > 128 → repeat next byte `(run - 128)` times
     - Run byte ≤ 128 → copy that many literal bytes
   - **Old-style flat**: 4 bytes per pixel directly
4. **RGBE → Float**: `rgbeToFloat(r, g, b, e)`:
   ```
   if e == 0: RGB = (0, 0, 0)
   else: scale = 2^(e - 136); RGB = (r * scale, g * scale, b * scale)
   ```
   Note: The exponent bias is 136 (= 128 + 8), matching Radiance convention.

### Stage 2: Spherical Harmonics — `computeSHFromEquirect()`

Computes 2nd-order (L=2) spherical harmonics from equirectangular panorama, matching BJS `SphericalPolynomial.FromHarmonics()`.

**Algorithm:**
1. For each pixel `(px, py)`:
   - `φ = (py + 0.5) / height * π` (polar angle)
   - `θ = (2(px + 0.5) / width - 1) * π` (azimuthal angle)
   - Direction: `(x, y, z) = (sinφ sinθ, cosφ, sinφ cosθ)`
   - Solid angle: `dΩ = sinφ * (π/height) * (2π/width)`
   - Clamp extreme values: if `max(r,g,b) > 4096`, scale down to cap at 4096
2. Accumulate 9 SH basis functions per color channel (27 total):
   - `Y₀₀ = 0.282094791773878`
   - `Y₁₋₁ = 0.48860251190292 * y`, `Y₁₀ = ... * z`, `Y₁₁ = ... * x`
   - `Y₂₋₂ = 1.092548430592079 * x*y`, etc.
3. Normalize by `4π / totalWeight`
4. Apply irradiance + Lambertian scaling: `L0 *= 1, L1 *= 2/3, L2 *= 1/4`
5. Convert SH → SphericalPolynomial (BJS `FromHarmonics` convention):
   - `poly[x] = L₁₁ * 1.02333 / π`
   - `poly[y] = L₁₋₁ * 1.02333 / π`
   - `poly[z] = L₁₀ * 1.02333 / π`
   - `poly[xx] = (L₀₀ * 0.886227 - L₂₀ * 0.247708 + L₂₂ * 0.429043) / π`
   - `poly[yy] = (L₀₀ * 0.886227 - L₂₀ * 0.247708 - L₂₂ * 0.429043) / π`
   - `poly[zz] = (L₀₀ * 0.886227 + L₂₀ * 0.495417) / π`
   - `poly[yz] = L₂₋₁ * 0.858086 / π`
   - `poly[zx] = L₂₁ * 0.858086 / π`
   - `poly[xy] = L₂₋₂ * 0.858086 / π`

Output: `Float32Array(27)` — 9 polynomial coefficients × 3 color channels (RGB interleaved per coefficient).

### Stage 3: Equirect → Cubemap — `equirectToCubemapGPU()`

GPU compute shader converts equirectangular panorama to 6-face cubemap.

**Input**: `rgba32float` 2D texture (equirect, with RGB→RGBA expansion on CPU)
**Output**: `rgba16float` 2D-array texture `[faceSize, faceSize, 6]`

**WGSL Compute Shader** (`EQUIRECT_TO_CUBE_WGSL`):
- Workgroup size: `(8, 8, 1)`, dispatched `ceil(faceSize/8) × ceil(faceSize/8) × 6`
- Face corner lookup: 24 pre-computed `vec3<f32>` corners (4 per face), matching BJS `panoramaToCubemap.ts` layout:
  - Layer 0: FACE_RIGHT, Layer 1: FACE_LEFT, Layer 2: FACE_UP, Layer 3: FACE_DOWN, Layer 4: FACE_FRONT, Layer 5: FACE_BACK
- Direction: bilinear interpolation of face corners using `u = x/size`, `v = y/size`
- Equirect UV: `eu = atan2(z, x) / π * 0.5 + 0.5`, `ev = acos(y) / π`
- Applies BJS `invertY` convention: `py = height - py_raw - 1`

**Resources created and destroyed**:
- Creates `equirectTex` (rgba32float), `paramBuf` (16B uniform) — both destroyed after dispatch
- `cubeTex` returned to caller

### Stage 4: Cubemap Prefiltering — `prefilterCubemapGPU()`

Importance-sampled GGX prefiltering for IBL specular cubemap, matching BJS `HDRFiltering`.

**Input**: Source cubemap from Stage 3
**Output**: `rgba16float` cube texture with `mipCount` mip levels

**Algorithm per mip level**:
- **LOD 0**: Exact texel copy (no bilinear resampling) via `copyTextureToTexture` — matches BJS behavior
- **LODs 1+**: For each texel:
  1. Compute direction `N` from face corners (same parameterization as Stage 3)
  2. `alphaG = 2^(mipLevel / 0.8) / srcSize` — roughness parameter for this mip
  3. Build tangent frame from `N`
  4. 1024 importance samples using Hammersley sequence:
     - `ξ₀ = i / 1024`, `ξ₁ = radicalInverseVdC(i)`
     - GGX half-vector: `H = importanceSampleGGX(ξ₀, ξ₁, alphaG)`
     - Reflect to get light direction: `L = 2(N·H)H - N`
     - PDF-based LOD: `sampleLod = 0.5 * log2(omegaS / omegaP) + 1.0`
     - Accumulate: `result += textureSampleLevel(srcCube, L, sampleLod).rgb * NdotL`
  5. Normalize by total NdotL weight

**One GPU submit per mip level** to ensure params buffer is consumed before next `writeBuffer`.

**Resources**: Source cubemap destroyed after prefiltering. Params buffer destroyed.

### Stage 5: BRDF LUT — `generateBrdfLut()`

Generates 256×256 `rgba16float` BRDF split-sum lookup table.

**WGSL Compute Shader** (`BRDF_LUT_WGSL`):
- Workgroup: `(8, 8)`, dispatch `(32, 32)`
- For each texel `(x, y)`:
  - `NdotV = max((x + 0.5) / 256, 0.001)`
  - `roughness = max((y + 0.5) / 256, 0.04)`
  - `a = roughness²`, `a2 = a²`
  - 1024 importance samples per texel
  - Smith-GGX height-correlated visibility: `V_Vis = 0.5 / (GGXV + GGXL) * NdotL * (4 * VdotH / NdotH)`
  - Schlick Fresnel split: `A += (1 - Fc) * V_Vis`, `B += Fc * V_Vis`
- Output layout: `vec4(B/N, (A+B)/N, 0, 1)` — matches BJS BRDF LUT convention

**Pipeline caching**: `_brdfPipeline` is cached module-level (first call creates, subsequent reuse).

### Full Pipeline Orchestration — `loadHdrEnvironment()`

```
fetch(url) → ArrayBuffer
     │
     ▼
parseRGBE() → HdrImage { width, height, data: Float32Array }
     │
     ▼
computeSHFromEquirect() → Float32Array(27) irradiance SH
     │
     ▼
equirectToCubemapGPU() → GPUTexture (rgba16float cube, mip 0 only)
     │
     ▼
prefilterCubemapGPU() → GPUTexture (rgba16float cube, all mips, GGX-filtered)
     │
     ▼
generateBrdfLut() → GPUTexture (rgba16float 256×256)
     │
     ▼
assembleEnvironmentTextures() → EnvironmentTextures
     │
     ▼
Set scene._envTextures, scene._irradianceSH
Set imageProcessing: toneMappingEnabled=false, exposure=0.8, contrast=1.2
Register deferred builder for background renderables (skybox + ground)
```

Post-load cleanup:
- Specular cube and BRDF LUT are ref-counted via `acquireGPUTexture()` / `releaseGPUTexture()`
- Disposables registered on `scene._disposables` for cleanup on scene destroy

## Pipeline Configuration

### Compute Pipeline: Equirect → Cubemap
- Layout: `"auto"`
- Bind group 0:
  - binding 0: `equirect` — `texture_2d<f32>` (input panorama)
  - binding 1: `cubeFaces` — `texture_storage_2d_array<rgba16float, write>` (output)
  - binding 2: `params` — uniform buffer (faceSize, equirectWidth, equirectHeight)

### Compute Pipeline: Cubemap Prefilter
- Layout: `"auto"`
- Bind group 0:
  - binding 0: `srcCube` — `texture_cube<f32>` (input cubemap)
  - binding 1: `srcSampler` — `sampler` (linear filtering)
  - binding 2: `dstFaces` — `texture_storage_2d_array<rgba16float, write>` (output mip)
  - binding 3: `params` — uniform buffer (faceSize, mipLevel, totalMips, srcSize)

### Compute Pipeline: BRDF LUT
- Layout: `"auto"`
- Bind group 0:
  - binding 0: `outputTex` — `texture_storage_2d<rgba16float, write>`

## Shader Logic

See Stage 3, 4, 5 above for complete WGSL pseudocode and math.

Key mathematical functions:
- **radicalInverseVdC**: Van der Corput sequence for quasi-random sampling (bit reversal)
- **importanceSampleGGX**: Generates half-vectors distributed according to GGX NDF
- **D_GGX**: `D = a² / (π * ((N·H)²(a²-1)+1)²)` — GGX normal distribution
- **integrateBRDF**: Smith-GGX visibility × Schlick Fresnel split-sum integration

## State Machine / Lifecycle

The loader is a one-shot async function. No persistent state beyond:
- `_brdfPipeline`: Module-level cached compute pipeline (created once per device lifetime)
- Deferred builders: Registered on `scene._deferredBuilders` for background renderables

## Babylon.js Equivalence Map

| Babylon.js | Babylon Lite |
|---|---|
| `HDRCubeTexture` | `loadHdrEnvironment()` |
| `HDRTools.RGBE_ReadPixels` | `parseRGBE()` → `decodeScanline()` |
| `CubeMapToSphericalPolynomialTools` | `computeSHFromEquirect()` |
| `panoramaToCubemap.ts` face corners | `CORNERS` const array in WGSL |
| `HDRFiltering` (importance-sampled GGX) | `prefilterCubemapGPU()` compute shader |
| `BRDFTextureTools.GetBRDFTexture` | `generateBrdfLut()` compute shader |
| `EnvironmentTextureTools` | `assembleEnvironmentTextures()` |

## Dependencies

- `../loader-env/load-env.js` — `EnvironmentTextures` type
- `../loader-env/env-helpers.js` — `assembleEnvironmentTextures()`
- `../resource/gpu-pool.js` — `acquireGPUTexture`, `releaseGPUTexture`, `getOrCreateSampler`
- `../scene/scene.js` — `SceneContext`, `SceneContextInternal`
- `../engine/engine.js` — `EngineInternal` (for device access)
- `../material/pbr/background-hdr-skybox.js` — dynamically imported for HDR skybox
- `../material/pbr/background-renderable.js` — dynamically imported for solid skybox/ground

## Test Specification

1. **RGBE parsing**: Verify correct width/height extraction and pixel values for known .hdr files
2. **RLE decoding**: Verify both new-style (4-channel RLE) and old-style (flat) scanline decoding
3. **RGBE→Float conversion**: Verify `2^(e-136)` scaling produces correct HDR values
4. **Spherical harmonics**: Verify SH coefficients against BJS reference for a known panorama
5. **Equirect→cubemap**: Verify face directions match BJS corner conventions; verify UV mapping
6. **GGX prefiltering**: Verify LOD 0 is exact copy; verify higher LODs are increasingly blurred
7. **BRDF LUT**: Verify 256×256 output matches BJS split-sum format
8. **Pipeline integration**: Verify `loadHdrEnvironment()` produces valid `EnvironmentTextures`
9. **Resource cleanup**: Verify intermediate textures (equirect, source cube) are destroyed

## File Manifest

| File | Purpose |
|---|---|
| `load-hdr.ts` | Public API: orchestrates full HDR→IBL pipeline, sets up scene environment and deferred builders |
| `hdr-parser.ts` | CPU-side RGBE parsing and spherical harmonics extraction from equirectangular panorama |
| `hdr-ibl-pipeline.ts` | GPU compute shaders: equirect→cubemap, importance-sampled GGX prefiltering, BRDF LUT generation |
