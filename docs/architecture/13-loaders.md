# Module: Loaders (glTF + .env + HDR + .babylon + Skybox)
> Package paths:
> - `packages/babylon-lite/src/loader-gltf/load-gltf.ts` — GLB 2.0 loader
> - `packages/babylon-lite/src/loader-env/load-env.ts` — Babylon .env environment loader
> - `packages/babylon-lite/src/loader-env/load-dds-env.ts` — DDS cubemap environment loader
> - `packages/babylon-lite/src/loader-env/env-helpers.ts` — Shared environment assembly helpers
> - `packages/babylon-lite/src/loader-env/brdf-rgbd-decode.ts` — BRDF PNG RGBD decode (GPU compute)
> - `packages/babylon-lite/src/loader-hdr/load-hdr.ts` — HDR panorama environment loader
> - `packages/babylon-lite/src/loader-hdr/hdr-parser.ts` — RGBE CPU parser + SH extraction
> - `packages/babylon-lite/src/loader-hdr/hdr-ibl-pipeline.ts` — GPU compute IBL pipeline
> - `packages/babylon-lite/src/loader-babylon/load-babylon.ts` — .babylon scene format loader
> - `packages/babylon-lite/src/loader-skybox/load-skybox.ts` — Cube texture skybox loader
> - `packages/babylon-lite/src/loader-skybox/skybox-renderable.ts` — Skybox renderable builder

## Purpose

The Loaders module provides six asset loading pipelines:

1. **glTF Loader** — Parses `.glb` (binary glTF 2.0) files, extracts mesh geometry (positions, normals, tangents, UVs, indices), resolves the node hierarchy to compute world matrices with RH→LH conversion, extracts PBR metallic-roughness material data (textures + factors), uploads everything to GPU buffers and textures with mipmaps.

2. **Environment Loader (.env)** — Parses Babylon.js `.env` files, decodes RGBD-encoded specular cubemap faces to `rgba16float`, decodes a pre-baked BRDF integration LUT from an RGBD-encoded PNG via GPU compute, extracts spherical harmonics irradiance coefficients, and uploads everything to GPU textures.

3. **DDS Environment Loader** — Loads pre-filtered DDS cubemap environments (rgba16float). Uploads all mip levels directly, computes spherical harmonics from mip 0 face data, and decodes a pre-baked BRDF LUT from a PNG via GPU compute.

4. **HDR Environment Loader** — Loads Radiance `.hdr` (RGBE) equirectangular panoramas. CPU-parses RGBE data, computes spherical harmonics, converts equirect→cubemap via GPU compute, prefilters with importance-sampled GGX via GPU compute, generates BRDF LUT via GPU compute.

5. **.babylon Format Loader** — Parses Babylon.js `.babylon` scene files. Supports standard materials (diffuse, bump, specular, ambient, lightmap, opacity, reflection textures), inline vertex data, point lights, scene clear color, and sub-mesh / multi-material handling.

6. **Skybox Loader** — Loads 6-face cube texture skyboxes for StandardMaterial scenes. Registers a deferred builder that creates the pipeline at engine start time.

## Public API Surface

### `loader-results.ts`

```typescript
/** Unified result returned by both loadGltf() and loadBabylon(). */
export interface LoaderResult {
  /**
   * Scene entities with world transforms (meshes, transform nodes, lights).
   * - glTF: single-element [root TransformNode]; meshes live in its hierarchy.
   * - .babylon: flat array of every Mesh + LightBase in the file.
   */
  entities: Array<Mesh | TransformNode | LightBase>;

  /** Animation groups from the file. scene.add() auto-ticks them each frame. */
  animationGroups?: AnimationGroup[];

  /** Scene clear color from the file. scene.add() applies it to ctx.clearColor. */
  clearColor?: GPUColorDict;
}
```

### `load-gltf.ts`

```typescript
/** Parsed mesh data ready for GPU upload. */
export interface GltfMeshData {
  positions: Float32Array;
  normals: Float32Array;
  tangents: Float32Array | null;
  uvs: Float32Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  indexCount: number;
  worldMatrix: Mat4;
  material: GltfMaterialData;
}

/** Parsed PBR material data. */
export interface GltfMaterialData {
  baseColorFactor: [number, number, number, number];
  metallicFactor: number;
  roughnessFactor: number;
  emissiveFactor: [number, number, number];
  baseColorImage: ImageBitmap | null;
  metallicRoughnessImage: ImageBitmap | null;
  normalImage: ImageBitmap | null;
  occlusionImage: ImageBitmap | null;
  emissiveImage: ImageBitmap | null;
}

/** Load a .glb file, parse it, upload to GPU. Returns a LoaderResult. */
export async function loadGltf(engine: Engine, url: string): Promise<LoaderResult>;
```

> **Note**: `loadGltf` takes an `Engine` (not `SceneContext`) and returns a `LoaderResult`. The result's `entities` array contains a **single** `TransformNode` (the glTF scene root). All meshes hang off that root's hierarchy. Pass the result to `scene.add()` — it will traverse the hierarchy, register animation ticks, and integrate everything into the scene. To access the root node directly: `const root = result.entities[0] as TransformNode`. Meshes are the standard `Mesh` type with GPU data in the `_gpu` field and bounding box on `Mesh.boundMin`/`Mesh.boundMax`.

### `load-env.ts`

```typescript
/** GPU-resident environment textures. */
export interface EnvironmentTextures {
  specularCube: GPUTexture;
  specularCubeView: GPUTextureView;
  brdfLut: GPUTexture;
  brdfLutView: GPUTextureView;
  cubeSampler: GPUSampler;
  brdfSampler: GPUSampler;
  irradianceSH: Float32Array;
  sphericalHarmonics: {
    l00: Float32Array; l1_1: Float32Array; l10: Float32Array; l11: Float32Array;
    l2_2: Float32Array; l2_1: Float32Array; l20: Float32Array; l21: Float32Array;
    l22: Float32Array;
  };
}

/** Load a Babylon.js .env file, upload cubemap + BRDF LUT to GPU. */
export async function loadEnvironment(
  scene: SceneContext,
  url: string,
  options: {
    brdfUrl: string;           // Required: URL of pre-baked BRDF LUT PNG (RGBD-encoded)
    groundTextureUrl?: string; // Optional: URL of ground texture
    skipSkybox?: boolean;      // Default: false — skip skybox renderable
    skipGround?: boolean;      // Default: false — skip ground plane
    skyboxUrl?: string;        // Override skybox texture URL
    skyboxSize?: number;       // Default: 1000 — skybox cube half-size
  },
): Promise<EnvironmentTextures>;
```

## Internal Architecture

### glTF Loader Pipeline

```
fetch(url) → ArrayBuffer
  ↓
parseGlbContainer(buffer)
  ↓
{ json, binChunk: DataView }
  ↓
extractAllMeshes(json, binChunk)       // for each node with mesh
  ├── resolveAccessor() × N            // positions, normals, tangents, UVs, indices
  ├── extractMaterial()                 // PBR factors + textures
  │     └── resolveImage() × 5         // parallel image decode
  └── computeNodeWorldMatrix()         // recursive parent chain + RH→LH root
  ↓
GltfMeshData[]
  ↓
uploadMeshes(device, meshDatas)
  ├── uploadTexture() × 4              // → Texture2D objects (cached per bitmap + sRGB)
  ├── createBufferFromData() × 5       // pos, norm, tan, uv, idx
  ├── computeWorldBounds()             // world-space AABB
  └── assemble PbrMaterialProps        // { baseColorTexture, normalTexture, ormTexture, emissiveTexture?, _buildGroup: pbrGroupBuilder }
  ↓
Mesh[] + root TransformNode
  ↓
createAnimationGroups(json, ...)       // extract glTF animations → AnimationGroup[]
  ↓
LoaderResult { entities: [root], animationGroups }
  → returned to caller; scene.add() dispatches entities + registers animation ticks
```

**Texture caching**: Textures are cached per bitmap identity + sRGB flag to avoid duplicate GPU uploads. Uses a `Map<string, Texture2D>` with key format `${bitmapId}:${srgb?1:0}`.

**Animation support**: `loadGltf` extracts glTF animations, creates `AnimationGroup[]` via `createAnimationGroups()`, and returns them in `LoaderResult.animationGroups`. `scene.add()` registers `_beforeRender` callbacks for playback.

**PBR materials**: Each `PbrMaterialProps` created during upload includes `_buildGroup: pbrGroupBuilder`, imported from `pbr-material.ts`.

### GLB Container Format

```
Offset 0:  Header (12 bytes)
  [0..3]   magic: 0x46546C67 ("glTF" LE)
  [4..7]   version: 2
  [8..11]  total length

Offset 12: JSON Chunk
  [0..3]   chunkLength
  [4..7]   chunkType: 0x4E4F534A ("JSON" LE)
  [8..]    UTF-8 JSON

Offset 12+8+jsonLength: BIN Chunk
  [0..3]   chunkLength
  [4..7]   chunkType: 0x004E4942 ("BIN\0" LE)
  [8..]    Binary data
```

### Accessor Resolution

Supports component types:
| Constant | Value | TypedArray |
|---|---|---|
| `FLOAT` | 5126 | `Float32Array` |
| `UNSIGNED_SHORT` | 5123 | `Uint16Array` |
| `UNSIGNED_INT` | 5125 | `Uint32Array` |
| `UNSIGNED_BYTE` | 5121 | `Uint8Array` |

Type → component count:
| Type | Components |
|---|---|
| `SCALAR` | 1 |
| `VEC2` | 2 |
| `VEC3` | 3 |
| `VEC4` | 4 |
| `MAT4` | 16 |

Byte offset = `bufferView.byteOffset + accessor.byteOffset` (both default to 0).

### RH→LH Coordinate Conversion

glTF uses right-handed coordinates. Babylon Lite uses left-handed. The conversion is done via a root world matrix pre-multiply (not by negating Z in vertex data):

```typescript
// Root matrix: diag(-1, 1, 1, 1) — negates X axis
const RH_TO_LH_ROOT: Mat4 = [-1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1];
```

For top-level nodes: `worldMatrix = RH_TO_LH_ROOT × localMatrix`.
For child nodes: `worldMatrix = parentWorldMatrix × localMatrix`.

Local matrices are computed from glTF TRS: `mat4Compose(translation, rotation, scale)`, or directly from `node.matrix` if present.

Parent lookup is done by linear scan (`findParent`): iterates all nodes checking `children` arrays.

### Texture Upload

`uploadTexture(device, bitmap, srgb, sampler)` returns a `Texture2D` (with `texture`, `view`, `sampler`, `width`, `height`).

| Texture | sRGB | Format | Created when |
|---|---|---|---|
| `baseColor` | Yes | `rgba8unorm-srgb` | Always (fallback 1×1 white) |
| `normal` | No | `rgba8unorm` | Always (fallback 1×1 white) |
| `ORM` | No | `rgba8unorm` | Always (fallback 1×1 white) |
| `emissive` | Yes | `rgba8unorm-srgb` | Only if glTF has emissive image |

sRGB textures use `rgba8unorm-srgb` format so the GPU performs exact sRGB→linear conversion on sample. All textures get full mip chains via `generateMipmaps()`.

ORM packing follows glTF convention:
- **R** = Ambient Occlusion
- **G** = Roughness
- **B** = Metallic

If only `metallicRoughnessImage` or `occlusionImage` is available, it's used for the ORM texture (they may be the same image in glTF).

### Bounding Box Computation

World-space AABB is computed by transforming every vertex position through the world matrix:

```
for each vertex (lx, ly, lz):
  wx = world[0]*lx + world[4]*ly + world[8]*lz  + world[12]
  wy = world[1]*lx + world[5]*ly + world[9]*lz  + world[13]
  wz = world[2]*lx + world[6]*ly + world[10]*lz + world[14]
  update min/max
```

### Shared Sampler

One sampler is created and shared across all `Texture2D` objects within a single `uploadMeshes()` call: `magFilter: linear, minFilter: linear, mipmapFilter: linear, addressMode: repeat` (both U and V). The sampler is stored inside each `Texture2D.sampler`.

---

### Environment Loader Pipeline

```
fetch(url) → ArrayBuffer
  ↓
parseEnvFile(buffer)
  ├── Validate 8-byte magic: [0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36]
  ├── Parse JSON manifest (UTF-8, null-terminated after magic)
  ├── Extract irradiance SH (9 vec3 = 27 floats from manifest.irradiance)
  └── Extract face image blobs (mip0_face0..5, mip1_face0..5, ...)
  ↓
{ faceBlobs[], irradianceSH, width, mipCount }
  ↓
createImageBitmap() × N faces (parallel, premultiplyAlpha:'none', colorSpaceConversion:'none')
  ↓
uploadCubemapRGBD(device, images, width, mipCount)
  ↓
GPUTexture (rgba16float cubemap)
  ↓
fetch(options.brdfUrl) + decodeBrdfPng(device, png) → 256×256 rgba16float BRDF LUT (GPU compute)
  ↓
polynomialToPreScaledHarmonics(irradianceSH) → pre-scaled SH for shader
  ↓
EnvironmentTextures → stored on scene._envTextures
```

### .env File Format

```
[0..7]     Magic: 86 16 87 96 F6 D6 96 36
[8..N]     JSON manifest (UTF-8, null terminated)
[N+1..]    Binary image data (PNG/JPEG face images)
```

JSON manifest fields:
- `width`: base cubemap face size
- `irradiance`: object with keys `x,y,z,xx,yy,zz,yz,zx,xy` → each is `[r,g,b]`
- `specular.mipmaps`: array of `{ position, length }` byte ranges
- `imageType`: MIME type (default `"image/png"`)

### RGBD Decoding

Each face image is RGBD-encoded. Decoding to linear HDR:

```
r_linear = pow(r_srgb, 2.2) / max(alpha, 1/255)
g_linear = pow(g_srgb, 2.2) / max(alpha, 1/255)
b_linear = pow(b_srgb, 2.2) / max(alpha, 1/255)
a_out    = 1.0
```

The process uses GPU staging to avoid Canvas 2D premultiplied-alpha corruption:
1. Upload `ImageBitmap` → temp `rgba8unorm` texture
2. Copy texture → staging buffer (256-byte aligned rows)
3. Map staging buffer for CPU read
4. Decode RGBD on CPU with Y-flip (Babylon uploads with `invertY=true`)
5. Upload decoded `float16` data to final `rgba16float` cubemap layer

### Float16 Conversion (`floatToHalf`)

IEEE 754 binary16 conversion via bit manipulation:
```
sign     = (float32_bits >>> 16) & 0x8000
exponent = ((float32_bits >>> 23) & 0xFF) - 127 + 15
mantissa = (float32_bits >>> 13) & 0x03FF
```
Handles denormalized numbers, overflow (→ infinity), and NaN.

### BRDF LUT Generation

> **Note on `.env` loader**: The `.env` (`loadEnvironment`) path no longer CPU-computes the BRDF LUT. It instead decodes a pre-baked BRDF LUT from an RGBD-encoded PNG provided via `options.brdfUrl`, using GPU compute in `brdf-rgbd-decode.ts`. The CPU algorithm below applies to the **HDR loader** (`hdr-ibl-pipeline.ts`) only.

GPU compute split-sum integration (256×256, `rgba16float`, HDR path):

For each texel `(x, y)`:
```
NdotV     = max((x + 0.5) / 256, 0.001)
roughness = max((y + 0.5) / 256, 0.04)
[A, B]    = integrateBRDF(NdotV, roughness, 1024 samples)
```

Output convention (Babylon):
- **R** = `B` (Fresnel bias)
- **G** = `A + B` (scale + bias)
- Shader usage: `F0 × A + B = F0 × (brdf.g - brdf.r) + brdf.r`

#### `integrateBRDF` Algorithm

Hammersley sequence + importance-sampled GGX:

```
for i in 0..1024:
  xi0 = i / sampleCount
  xi1 = radicalInverseVdC(i)          // Van der Corput
  H = importanceSampleGGX(xi0, xi1, roughness⁴)
  VdotH = max(V·H, 0)
  Lz = 2 × VdotH × H.z - V.z          // reflect(-V, H).z = NdotL
  NdotL = max(Lz, 0)
  NdotH = max(H.z, 0)

  if NdotL > 0 and NdotH > 0:
    // Smith height-correlated visibility
    GGXV = NdotL × √(NdotV² × (1-a2) + a2)
    GGXL = NdotV × √(NdotL² × (1-a2) + a2)
    V_Vis = 0.5 / max(GGXV+GGXL, 1e-6) × NdotL × 4×VdotH/NdotH
    Fc = (1 - VdotH)⁵
    A += (1 - Fc) × V_Vis
    B += Fc × V_Vis

return [A/1024, B/1024]
```

#### `importanceSampleGGX`

```
phi = 2π × xi0
cosTheta = √((1 - xi1) / (1 + (a2 - 1) × xi1))
sinTheta = √(1 - cosTheta²)
return [cos(phi) × sinTheta, sin(phi) × sinTheta, cosTheta]
```

#### `radicalInverseVdC`

Van der Corput radical inverse (bit reversal):
```
bits = input >>> 0
bits = ((bits << 16) | (bits >>> 16)) >>> 0
bits = ((bits & 0x55555555) << 1) | ((bits & 0xAAAAAAAA) >>> 1)   // swap odd/even
bits = ((bits & 0x33333333) << 2) | ((bits & 0xCCCCCCCC) >>> 2)   // swap pairs
bits = ((bits & 0x0F0F0F0F) << 4) | ((bits & 0xF0F0F0F0) >>> 4)   // swap nibbles
bits = ((bits & 0x00FF00FF) << 8) | ((bits & 0xFF00FF00) >>> 8)   // swap bytes
return bits × 2.3283064365386963e-10                               // / 2^32
```

### Spherical Harmonics Conversion

Converts from Babylon.js polynomial representation (27 floats: x,y,z,xx,yy,zz,yz,zx,xy) to pre-scaled harmonics for shader use.

**Step 1: `FromPolynomial`** (matching Babylon.js `SphericalHarmonics.FromPolynomial()`):

```
K00 = 0.376127,  K1 = 0.977204,  K2 = 1.16538
K20_zz = 1.34567, K20_xy = 0.672834

L00   = (xx×K00 + yy×K00 + zz×0.376126) × π
L1_-1 = y × (-K1) × π
L10   = z × K1 × π
L11   = x × (-K1) × π
L2_-2 = xy × K2 × π
L2_-1 = yz × (-K2) × π
L20   = (zz×K20_zz - xx×K20_xy - yy×K20_xy) × π
L21   = zx × (-K2) × π
L22   = (xx - yy) × K2 × π
```

**Step 2: `preScaleForRendering`** (SH basis function coefficients):

```
B00  = √(1/(4π)),      B1m = -√(3/(4π)),     B1p = √(3/(4π))
B2_2 = √(15/(4π)),     B2_1 = -√(15/(4π)),   B20 = √(5/(16π))
B21  = -√(15/(4π)),     B22 = √(15/(16π))

output_L00   = raw_L00 × B00
output_L1_-1 = raw_L1_-1 × B1m
...etc
```

## Babylon.js Equivalence Map

| Babylon Lite | Babylon.js |
|---|---|
| `loadGltf(scene, url)` | `BABYLON.SceneLoader.Append(url, scene)` |
| `Mesh` (with `_gpu` field) | Internal mesh representation |
| `RH_TO_LH_ROOT` | Root node rotation `[0,1,0,0]` + scale `[1,1,-1]` |
| `loadEnvironment(scene, url, { brdfUrl })` | `scene.environmentTexture = new BABYLON.CubeTexture.CreateFromPrefilteredData(url)` |
| `.env` file format | Babylon-proprietary environment file |
| RGBD decode | `FromRGBD` shader in Babylon |
| `generateBrdfLut()` (GPU compute, RGBD PNG decode, in brdf-rgbd-decode.ts) | Babylon ships pre-baked BRDF LUT (also option for runtime) |
| `polynomialToPreScaledHarmonics()` | `SphericalHarmonics.FromPolynomial()` + `preScaleForRendering()` |
| `uploadCubemapRGBD()` | Internal cubemap processing in `HDRCubeTexture` |
| Staging buffer RGBD decode | Avoids Canvas 2D premultiplication issue |
| `loadDdsEnvironment(scene, url, opts)` | `BABYLON.CubeTexture.CreateFromPrefilteredData(url)` with DDS file |
| `computeSH()` (from DDS mip 0) | BJS `SphericalPolynomial.FromHarmonics` on cubemap |
| `decodeBrdfPng()` | BJS embedded `environmentBRDFTexture` (RGBD PNG) |
| `loadHdrEnvironment(scene, url, opts)` | `new BABYLON.HDRCubeTexture(url, scene)` |
| `parseRGBE()` | BJS `HDRTools.GetCubeMapTextureData()` |
| `computeSHFromEquirect()` | BJS `SphericalPolynomial.FromEquirectangular()` |
| `equirectToCubemapGPU()` | BJS `panoramaToCubemap.ts` CPU conversion |
| `prefilterCubemapGPU()` | BJS `hdrFiltering.ts` GPU prefilter |
| `generateBrdfLut()` (GPU compute, in hdr-ibl-pipeline.ts) | BJS compute-based BRDF LUT |
| `loadBabylon(engine, url)` | `BABYLON.SceneLoader.Load("", url, engine)` |
| `createStandardMaterial()` | `new BABYLON.StandardMaterial("mat", scene)` |
| `loadTexture2D()` | `new BABYLON.Texture(url, scene)` |
| `createPointLight()` | `new BABYLON.PointLight("light", pos, scene)` |
| SubMesh + multiMaterial | `BABYLON.SubMesh` + `BABYLON.MultiMaterial` |
| `loadSkybox(scene, baseUrl, ext, size)` | `new BABYLON.CubeTexture(url, scene)` + skybox mesh |
| `buildSkyboxRenderable()` | `skyboxMaterial` + `skyboxMesh` in BJS `EnvironmentHelper` |

## Dependencies

- **`load-gltf.ts` imports**: `Engine` from `../engine/engine.js`; `Mat4` from `../math/types.js`; `mat4Compose`, `mat4Multiply` from `../math/mat4.js`; `generateMipmaps`, `mipLevelCount` from `../texture/generate-mipmaps.js`; `Texture2D` from `../texture/texture-2d.js`; `PbrMaterialProps`, `pbrGroupBuilder` from `../material/pbr/pbr-material.js`; `createAnimationGroups` from `../animation/animation-group.js`; `LoaderResult` from `../loader-results.js`.
- **`load-env.ts` imports**: `SceneContext` from `../scene/scene.js`.
- **`load-dds-env.ts` imports**: `SceneContext`, `SceneContextInternal` from `../scene/scene.js`; `EngineInternal` from `../engine/engine.js`; `EnvironmentTextures` from `./load-env.js`; `acquireGPUTexture`, `releaseGPUTexture` from `../resource/gpu-pool.js`; `assembleEnvironmentTextures` from `./env-helpers.js`; dynamic import of `./brdf-rgbd-decode.js`.
- **`env-helpers.ts` imports**: `EnvironmentTextures`, `polynomialToPreScaledHarmonics` from `./load-env.js`; `getOrCreateSampler` from `../resource/gpu-pool.js`.
- **`brdf-rgbd-decode.ts` imports**: None (standalone GPU compute).
- **`load-hdr.ts` imports**: `EnvironmentTextures` from `../loader-env/load-env.js`; `SceneContext`, `SceneContextInternal` from `../scene/scene.js`; `EngineInternal` from `../engine/engine.js`; `acquireGPUTexture`, `releaseGPUTexture` from `../resource/gpu-pool.js`; `assembleEnvironmentTextures` from `../loader-env/env-helpers.js`; `parseRGBE`, `computeSHFromEquirect` from `./hdr-parser.js`; `equirectToCubemapGPU`, `prefilterCubemapGPU`, `generateBrdfLut` from `./hdr-ibl-pipeline.js`; dynamic imports: `../material/pbr/background-hdr-skybox.js`, `../material/pbr/background-renderable.js`.
- **`hdr-parser.ts` imports**: None (standalone CPU code).
- **`hdr-ibl-pipeline.ts` imports**: `HdrImage` from `./hdr-parser.js`; `getOrCreateSampler` from `../resource/gpu-pool.js`.
- **`load-babylon.ts` imports**: `Engine`, `EngineInternal` from `../engine/engine.js`; `createStandardMaterial`, `StandardMaterialProps` from `../material/standard/standard-material.js`; `uploadMeshToGPU`, `initMeshTransform`, `MeshInternal` from `../mesh/mesh.js`; `createPointLight` from `../light/point-light.js`; `loadTexture2D` from `../texture/texture-2d.js`; `LoaderResult` from `../loader-results.js`.
- **`load-skybox.ts` imports**: `SceneContext`, `SceneContextInternal` from `../scene/scene.js`; `EngineInternal` from `../engine/engine.js`; `loadCubeTexture` from `../texture/cube-texture.js`; `createBoxData` from `../mesh/create-box.js`; dynamic import: `./skybox-renderable.js`.
- **`skybox-renderable.ts` imports**: `SceneContext` from `../scene/scene.js`; `EngineInternal` from `../engine/engine.js`; `SkyboxData` from `./load-skybox.js`; `Renderable` from `../render/renderable.js`; `buildSkyboxCubeMapGPU` from `../material/standard/skybox-cubemap.js`.
- **Depended on by**: `pbr-renderable.ts` (consumes `Mesh`), `index.ts` (type exports), scene setup files.

## Test Specification

| Test | Description |
|---|---|
| **glTF** | |
| `parseGlbContainer validates magic` | Non-GLB input throws |
| `parseGlbContainer extracts JSON + BIN` | Verify correct chunk parsing |
| `resolveAccessor FLOAT` | Returns Float32Array with correct count |
| `resolveAccessor UNSIGNED_SHORT` | Returns Uint16Array |
| `RH_TO_LH_ROOT negates X` | Verify diag(-1,1,1,1) |
| `computeNodeWorldMatrix top-level` | Pre-multiplied by RH_TO_LH_ROOT |
| `computeNodeWorldMatrix child` | Parent world × child local |
| `extractMaterial defaults` | Missing material → baseColorFactor [1,1,1,1], metallic 1, roughness 1 |
| `uploadTexture sRGB format` | baseColor uses rgba8unorm-srgb |
| `uploadTexture null fallback` | 1×1 white texture |
| `computeWorldBounds` | Known positions × identity matrix → correct AABB |
| **.env** | |
| `.env magic validation` | Bad magic → throws |
| `RGBD decode` | Known RGBD values → correct linear HDR |
| `floatToHalf` | 1.0 → 0x3C00, 0.0 → 0x0000 |
| `BRDF LUT dimensions` | 256×256, rgba16float |
| `integrateBRDF NdotV=1 roughness=0.04` | Known approximate values |
| `radicalInverseVdC(0)` | Returns 0 |
| `SH conversion roundtrip` | Polynomial → harmonics matches Babylon reference values |
| **DDS env** | |
| `DDS header parsing` | Correct width, height, mipCount, dataOffset extraction |
| `float16ToFloat32` | 0x3C00 → 1.0, 0x0000 → 0.0 |
| `computeSH from DDS` | Known cubemap data → SH coefficients match BJS reference |
| `decodeBrdfPng RGBD` | Known PNG RGBD values → correct rgba16float output |
| **HDR** | |
| `parseRGBE validates signature` | Missing `#?` → throws |
| `parseRGBE unsupported format` | Non-`32-bit_rle_rgbe` → throws |
| `parseRGBE resolution parsing` | Correct width/height extraction |
| `rgbeToFloat e=0` | Returns (0,0,0) |
| `rgbeToFloat known values` | `[128, 128, 128, 136]` → `(128, 128, 128)` |
| `computeSHFromEquirect` | Known equirect data → SH matches reference |
| `equirectToCubemapGPU output format` | rgba16float, faceSize × faceSize × 6 |
| `prefilterCubemapGPU mip count` | floor(log2(faceSize)) + 1 mip levels |
| `generateBrdfLut dimensions` | 256×256, rgba16float |
| **.babylon** | |
| `loadBabylon clearColor` | Scene clearColor set from JSON |
| `loadBabylon materials` | Standard material properties extracted correctly |
| `loadBabylon textures` | Texture URLs resolved relative to base URL |
| `loadBabylon multiMaterial` | SubMesh materialIndex maps to correct sub-material |
| `loadBabylon point lights` | Position, intensity, diffuse, specular, range |
| `loadBabylon mesh transform` | Position/rotation/scaling applied via initMeshTransform |
| `loadBabylon maxMeshes` | Respects mesh count limit |
| `loadBabylon invisible mesh` | isVisible=false skipped |
| **Skybox** | |
| `loadSkybox registers SkyboxData` | scene._skybox populated |
| `loadSkybox deferred builder` | Builder re-enqueues when UBO not ready |
| `buildSkyboxRenderable order 0` | Renders behind everything |

## File Manifest

| File | Size | Purpose |
|---|---|---|
| `src/loader-gltf/load-gltf.ts` | ~413 lines | GLB parsing, mesh extraction, texture upload, world matrix computation |
| `src/loader-env/load-env.ts` | ~470 lines | .env parsing, RGBD decode, BRDF LUT generation (CPU), SH conversion |
| `src/loader-env/load-dds-env.ts` | ~286 lines | DDS cubemap loader, float16 SH extraction, BRDF PNG decode orchestration |
| `src/loader-env/env-helpers.ts` | ~34 lines | Shared sampler creation, EnvironmentTextures assembly |
| `src/loader-env/brdf-rgbd-decode.ts` | ~52 lines | GPU compute RGBD PNG → rgba16float BRDF LUT decode |
| `src/loader-hdr/load-hdr.ts` | ~102 lines | HDR environment loader orchestrator, deferred background builder |
| `src/loader-hdr/hdr-parser.ts` | ~218 lines | RGBE CPU parser, RLE scanline decoder, equirect SH computation |
| `src/loader-hdr/hdr-ibl-pipeline.ts` | ~400 lines | GPU compute: equirect→cubemap, GGX prefilter, BRDF LUT generation |
| `src/loader-babylon/load-babylon.ts` | ~428 lines | .babylon JSON parser, standard materials, lights, mesh upload |
| `src/loader-skybox/load-skybox.ts` | ~96 lines | Cube texture loader + deferred skybox registration |
| `src/loader-skybox/skybox-renderable.ts` | ~32 lines | Skybox renderable builder wrapping skybox-cubemap material |
| `src/texture/generate-mipmaps.ts` | ~141 lines | GPU mipmap blit (shared utility) |
