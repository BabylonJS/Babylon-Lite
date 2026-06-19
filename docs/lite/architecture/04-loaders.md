# Module: Loaders (glTF + .env + HDR + .babylon + Skybox + Splats)
> Package paths:
> - `packages/babylon-lite/src/loader-gltf/load-gltf.ts` — GLB 2.0 loader
> - `packages/babylon-lite/src/loader-gltf/gltf-ext-basisu.ts` — glTF `KHR_texture_basisu` feature module
> - `packages/babylon-lite/src/loader-gltf/gltf-feature-meshopt.ts` + `meshopt-decode.ts` — `EXT_meshopt_compression` feature module + decoder
> - `packages/babylon-lite/src/loader-gltf/gltf-ext-quantization.ts` — `KHR_mesh_quantization` feature module
> - `packages/babylon-lite/src/loader-gltf/gltf-feature-xmp.ts` — `KHR_xmp_json_ld` metadata feature module
> - `packages/babylon-lite/src/loader-gltf/gltf-interleave.ts` — dynamic native interleaved-vertex-buffer support (de-strided CPU copies built lazily on demand)
> - `packages/babylon-lite/src/loader-env/load-env.ts` — Babylon .env environment loader
> - `packages/babylon-lite/src/loader-env/load-dds-env.ts` — DDS cubemap environment loader
> - `packages/babylon-lite/src/loader-env/env-helpers.ts` — Shared environment assembly helpers
> - `packages/babylon-lite/src/loader-env/rgbd-decode.ts` — Shared RGBD PNG/cubemap decode (GPU compute)
> - `packages/babylon-lite/src/loader-hdr/load-hdr.ts` — HDR panorama environment loader
> - `packages/babylon-lite/src/loader-hdr/hdr-parser.ts` — RGBE CPU parser + SH extraction
> - `packages/babylon-lite/src/loader-hdr/hdr-ibl-pipeline.ts` — GPU compute IBL pipeline
> - `packages/babylon-lite/src/loader-babylon/load-babylon.ts` — .babylon scene format loader
> - `packages/babylon-lite/src/loader-skybox/load-skybox.ts` — Cube texture skybox loader
> - `packages/babylon-lite/src/loader-skybox/skybox-renderable.ts` — Skybox renderable builder
> - `packages/babylon-lite/src/loader-splat/` — Gaussian splat loaders (`.ply`, `.splat`, `.sog`, `.spz`)

## Purpose

The Loaders module provides asset loading pipelines plus dynamic glTF feature modules:

1. **glTF Loader** — Parses `.glb` / `.gltf` 2.0 files, dynamically imports feature modules based on `extensionsUsed` and material/primitive content, extracts mesh geometry (positions, normals, tangents, UVs, indices), resolves the node hierarchy to compute world matrices with RH→LH conversion, extracts PBR metallic-roughness material data (textures + factors), uploads everything to GPU buffers and textures with mipmaps. Optional features such as `KHR_texture_basisu` live in separate dynamic modules so assets that do not use them pay zero runtime bytes.

2. **Environment Loader (.env)** — Parses Babylon.js `.env` files, decodes RGBD-encoded specular cubemap faces to `rgba16float`, decodes a pre-baked BRDF integration LUT from an RGBD-encoded PNG via GPU compute, extracts spherical harmonics irradiance coefficients, and uploads everything to GPU textures.

3. **DDS Environment Loader** — Loads pre-filtered DDS cubemap environments (rgba16float). Uploads all mip levels directly, computes spherical harmonics from mip 0 face data, and decodes a pre-baked BRDF LUT from a PNG via GPU compute.

4. **HDR Environment Loader** — Loads Radiance `.hdr` (RGBE) equirectangular panoramas. CPU-parses RGBE data, computes spherical harmonics, converts equirect→cubemap via GPU compute, prefilters with importance-sampled GGX via GPU compute, generates BRDF LUT via GPU compute.

5. **.babylon Format Loader** — Parses Babylon.js `.babylon` scene files. Supports standard materials (diffuse, bump, specular, ambient, lightmap, opacity, reflection textures), inline vertex data, point lights, scene clear color, and sub-mesh / multi-material handling.

6. **Skybox Loader** — Loads 6-face cube texture skyboxes for StandardMaterial scenes. Registers a deferred builder that creates the pipeline at engine start time.

7. **Gaussian Splat Loaders** — Load `.ply`, `.splat`, `.sog`, and `.spz` splat assets into `GaussianSplattingMesh` instances. SOG handles ZIP-packed WebP payloads; SPZ handles gzip-wrapped binary streams. Transform baking helpers and material shader fragments are exposed separately so non-splat scenes pay zero runtime cost.

## Public API Surface

### `asset-container.ts`

```typescript
/** Unified result returned by both loadGltf() and loadBabylon(). */
export interface AssetContainer {
  /**
   * Scene entities with world transforms (meshes, transform nodes, lights).
   * - glTF: single-element [root TransformNode]; meshes live in its hierarchy.
   * - .babylon: root SceneNodes + LightBase objects in the file.
   */
  entities: Array<SceneNode | LightBase>;

  /** Animation groups from the file. addToScene() auto-ticks them each frame. */
  animationGroups?: AnimationGroup[];

  /** Scene clear color from the file. addToScene() applies it to ctx.clearColor. */
  clearColor?: GPUColorDict;

  /** Camera parsed from the file. addToScene() sets it as scene.camera when present. */
  camera?: Camera;

  /** KHR_materials_variants data. Use selectVariant() / getVariantNames() to interact. */
  materialVariants?: MaterialVariantData;
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

/** Load a glTF/GLB asset from a URL, ArrayBuffer, or Blob; parse it, upload to GPU. Returns an AssetContainer. */
export async function loadGltf(engine: EngineContext, source: string | ArrayBuffer | Blob): Promise<AssetContainer>;
```

> **Note**: `loadGltf` takes an `Engine` (not `SceneContext`) and returns an `AssetContainer`. The result's `entities` array contains root scene entities; glTF meshes usually hang off a root `TransformNode` hierarchy. Pass the result to `addToScene(scene, result)` — it will traverse the hierarchy, register animation ticks, and integrate everything into the scene. Meshes are the standard `Mesh` type with GPU data in the `_gpu` field and bounding box on `Mesh.boundMin`/`Mesh.boundMax`.
>
> **Local data**: `source` may be a URL `string`, or an `ArrayBuffer`/`Blob` of an already-loaded asset (drag-and-drop, OPFS, a `fetch` body, etc.). GLB-vs-glTF is detected from the data's magic bytes, **not** the URL extension, so object URLs (`blob:…`) and extensionless sources load correctly. `ArrayBuffer`/`Blob` inputs have no base URL, so they must be self-contained (a GLB, or a glTF whose buffers/images use `data:` URIs); a glTF referencing external `.bin`/image files by relative path must be loaded from a URL.

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
loadFeatureModules(json)              // dynamic imports, e.g. KHR_texture_basisu
  ├── preMesh hooks                   // Draco, KTX2 strided FLOAT accessor decode, etc.
  └── material hooks                  // feature-owned texture/material overrides
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
  ├── runMatExts()                     // feature-owned material overrides, e.g. KTX2 textures
  ├── createBufferFromData() × 5       // pos, norm, tan, uv, idx
  ├── computeWorldBounds()             // world-space AABB
  └── assemble PbrMaterialProps        // { baseColorTexture, normalTexture, ormTexture, emissiveTexture?, _buildGroup: pbrGroupBuilder }
  ↓
Mesh[] + root TransformNode
  ↓
createAnimationGroups(json, ...)       // extract glTF animations → AnimationGroup[]
  ↓
AssetContainer { entities: [root], animationGroups }
  → returned to caller; addToScene() dispatches entities + registers animation ticks
```

**Texture caching**: Textures are cached per bitmap identity + sRGB flag to avoid duplicate GPU uploads. The hot-path cache uses a numeric key (`bitmapId * 2 + +srgb`) so plain-image glTF assets do not pay string-key overhead. Feature modules can maintain their own caches for extension-owned image sources.

**Animation support**: `loadGltf` extracts glTF animations, creates `AnimationGroup[]` via `createAnimationGroups()`, and returns them in `AssetContainer.animationGroups`. `addToScene()` registers playback with the scene-owned animation manager.

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

### `KHR_texture_basisu` / KTX2 Texture Sources

The `KHR_texture_basisu` implementation is a glTF feature module, not core loader logic:

```
extensionsUsed includes "KHR_texture_basisu"
  ↓
dynamic import("./gltf-ext-basisu.js")
  ↓
preMesh(json, binChunk, baseUrl)
  ├─ marks materials that reference KTX2 images
  ├─ strips KTX2 textureInfos before core image parsing
  └─ deinterleaves strided FLOAT vertex accessors when needed by the KTX2 asset
  ↓
core material parse runs with non-KTX2 textureInfos only
  ↓
applyMaterial(mat, ctx)
  ├─ fetches KTX2 bytes from image.uri or bufferView
  ├─ uploadKtx2Texture2D(ctx.engine, bytes, sRGB)
  ├─ composes ORM when metallic-roughness and occlusion are distinct KTX2 images
  └─ returns Partial<PbrMaterialProps> with feature-owned Texture2D values
```

Design constraints:

- No `KHR_texture_basisu` branches in the core material parser or PBR renderer.
- `ktx2-loader.ts` is reached only through `gltf-ext-basisu.ts`.
- The Babylon KTX2 decoder script is loaded lazily after a KTX2 asset is encountered.
- Core texture cache keys remain image-bitmap based; KTX2 feature caches by glTF texture index and sRGB flag.
- Scene 112 (`FlightHelmetKTX`) validates the path and keeps existing scene runtime bundle sizes unchanged.

### Interleaved Vertex Buffers (`gltf-interleave.ts`)

glTF allows multiple vertex attributes to share one `bufferView` with a non-zero
`byteStride` (interleaved layout). Babylon Lite supports this **at the GPU level**
rather than rewriting the asset:

```
primitive has a strided (byteStride > 0), non-decoded accessor
  ↓
dynamic import("./gltf-interleave.js")   // never fetched by tight-only scenes
  ↓
buildInterleavedPartial(json, binChunk, attrs)
  ├─ records each strided attribute's { bufferView slice, offset, stride }
  └─ resolves tight attributes directly
  ↓
uploadMeshes binds the ONE raw bufferView slice to every attribute slot at the
attribute's byte offset with pipeline arrayStride = byteStride
```

Design constraints:

- **No CPU de-interleave / asset rewrite.** The raw interleaved bytes are uploaded
  once and bound to each slot — the GPU does the striding.
- **De-strided CPU copies are lazy.** `installLazyCpu()` defines
  `_cpuPositions/_cpuNormals/_cpuUvs` as caching getters that de-stride on first
  access; a mesh that is never picked / CSG'd / navigated never materializes them.
- **Zero cost to non-interleaved scenes.** The whole module is dynamic-imported and
  only loaded when a genuinely-strided, non-decoded primitive is encountered. Decoded
  paths (Draco, `KHR_texture_basisu` de-stride) bypass it.
- Validated by Scene 210 (`XmpMetadataRoundedCube`, genuinely interleaved).

### `EXT_meshopt_compression` + `KHR_mesh_quantization` (`gltf-feature-meshopt.ts`, `gltf-ext-quantization.ts`)

`EXT_meshopt_compression` bufferViews are decoded by a dynamically-imported meshopt
decoder (`meshopt-decode.ts`) before accessor resolution; `KHR_mesh_quantization`
lets normalized/quantized attribute formats upload natively. Both are dynamic feature
modules, so non-meshopt scenes pay zero runtime bytes. Validated by Scene 211
(`BrainStem` glTF-Meshopt-EXT, skinned + animated).

### `KHR_xmp_json_ld` Metadata (`gltf-feature-xmp.ts`)

Pure metadata with no render effect: the feature's `applyAsset` hook surfaces the
document-level JSON-LD packets (and the `asset`-referenced packet) on
`AssetContainer.xmpMetadata = { packets, assetPacket }`. Dynamic-imported only when
`extensionsUsed` lists `KHR_xmp_json_ld`. Validated by Scene 210.

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

> **Note on `.env` and DDS loaders**: Environment loaders no longer CPU-compute the BRDF LUT. They decode a pre-baked BRDF LUT from an RGBD-encoded PNG provided via `options.brdfUrl`, using GPU compute in `rgbd-decode.ts`. The CPU algorithm below applies to the **HDR loader** (`hdr-ibl-pipeline.ts`) only.

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
| `addToScene(scene, await loadGltf(engine, url))` | `BABYLON.SceneLoader.Append(url, scene)` |
| `Mesh` (with `_gpu` field) | Internal mesh representation |
| `RH_TO_LH_ROOT` | Root node rotation `[0,1,0,0]` + scale `[1,1,-1]` |
| `loadEnvironment(scene, url, { brdfUrl })` | `scene.environmentTexture = new BABYLON.CubeTexture.CreateFromPrefilteredData(url)` |
| `.env` file format | Babylon-proprietary environment file |
| RGBD decode | `FromRGBD` shader in Babylon |
| `generateBrdfLut()` (GPU compute, RGBD PNG decode, in rgbd-decode.ts) | Babylon ships pre-baked BRDF LUT (also option for runtime) |
| `polynomialToPreScaledHarmonics()` | `SphericalHarmonics.FromPolynomial()` + `preScaleForRendering()` |
| `uploadCubemapRGBD()` | Internal cubemap processing in `HDRCubeTexture` |
| `KHR_texture_basisu` feature + `uploadKtx2Texture2D()` | BJS `KHR_texture_basisu` loader + `KTX2Decoder` texture upload |
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

- **`load-gltf.ts` imports**: `EngineContext` from `../engine/engine.js`; `Mat4` from `../math/types.js`; `mat4Compose`, `mat4Multiply` from `../math/mat4.js`; `generateMipmaps`, `mipLevelCount` from `../texture/generate-mipmaps.js`; `Texture2D` from `../texture/texture-2d.js`; `PbrMaterialProps`, `pbrGroupBuilder` from `../material/pbr/pbr-material.js`; `createAnimationGroups` from `../animation/animation-group.js`; `AssetContainer` from `../asset-container.js`; dynamic glTF feature imports including `gltf-ext-basisu.ts`.
- **`gltf-ext-basisu.ts` imports**: `decodeKtx2ImageBitmapFromBuffer`, `uploadKtx2Texture2D` from `../texture/ktx2-loader.js`; `resolveAccessor` from `./gltf-parser.js`; PBR and Texture2D types.
- **`load-env.ts` imports**: `SceneContext` from `../scene/scene.js`.
- **`load-dds-env.ts` imports**: `SceneContext`, `SceneContextInternal` from `../scene/scene.js`; `EngineInternal` from `../engine/engine.js`; `EnvironmentTextures` from `./load-env.js`; `acquireGPUTexture`, `releaseGPUTexture` from `../resource/gpu-pool.js`; `assembleEnvironmentTextures` from `./env-helpers.js`; dynamic import of `./rgbd-decode.js`.
- **`env-helpers.ts` imports**: `EnvironmentTextures`, `polynomialToPreScaledHarmonics` from `./load-env.js`; `getOrCreateSampler` from `../resource/gpu-pool.js`.
- **`rgbd-decode.ts` imports**: `EngineContextInternal` from `../engine/engine.js`.
- **`load-hdr.ts` imports**: `EnvironmentTextures` from `../loader-env/load-env.js`; `SceneContext`, `SceneContextInternal` from `../scene/scene.js`; `EngineInternal` from `../engine/engine.js`; `acquireGPUTexture`, `releaseGPUTexture` from `../resource/gpu-pool.js`; `assembleEnvironmentTextures` from `../loader-env/env-helpers.js`; `parseRGBE`, `computeSHFromEquirect` from `./hdr-parser.js`; `equirectToCubemapGPU`, `prefilterCubemapGPU`, `generateBrdfLut` from `./hdr-ibl-pipeline.js`; dynamic imports: `../material/pbr/background-hdr-skybox.js`, `../material/pbr/background-renderable.js`.
- **`hdr-parser.ts` imports**: None (standalone CPU code).
- **`hdr-ibl-pipeline.ts` imports**: `HdrImage` from `./hdr-parser.js`; `getOrCreateSampler` from `../resource/gpu-pool.js`.
- **`load-babylon.ts` imports**: `EngineContext`, `EngineInternal` from `../engine/engine.js`; `createStandardMaterial`, `StandardMaterialProps` from `../material/standard/standard-material.js`; `uploadMeshToGPU`, `initMeshTransform`, `MeshInternal` from `../mesh/mesh.js`; `createPointLight` from `../light/point-light.js`; `loadTexture2D` from `../texture/texture-2d.js`; `AssetContainer` from `../asset-container.js`.
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
| `KHR_texture_basisu` | Scene 112 FlightHelmetKTX loads KTX2 texture sources and matches Babylon.js within `maxMad: 0.02` |
| `KHR_texture_basisu bundle isolation` | Existing scenes have no positive runtime-loaded JS deltas when KTX2 support is present |
| `Interleaved vertex buffers` | Strided accessors resolve to GPU offset/stride; `gltf-interleave.test.ts` covers strided detection + lazy de-stride |
| `KHR_xmp_json_ld` | Scene 210 XmpMetadataRoundedCube (genuinely interleaved) matches Babylon.js within `maxMad: 0.2`; metadata surfaced on `AssetContainer.xmpMetadata` |
| `EXT_meshopt_compression` + `KHR_mesh_quantization` | Scene 211 BrainStem (glTF-Meshopt-EXT) matches Babylon.js within `maxMad: 0.2` |
| `glTF feature bundle isolation` | Non-interleaved / non-meshopt / non-XMP scenes never load the corresponding dynamic chunk (verified via `coverage:scene`) |
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
| `src/loader-env/load-env.ts` | ~470 lines | .env parsing, RGBD decode, BRDF LUT upload, SH conversion |
| `src/loader-env/load-dds-env.ts` | ~286 lines | DDS cubemap loader, float16 SH extraction, BRDF PNG decode orchestration |
| `src/loader-env/env-helpers.ts` | ~34 lines | Shared sampler creation, EnvironmentTextures assembly |
| `src/loader-env/rgbd-decode.ts` | ~125 lines | Shared GPU compute RGBD PNG/cubemap → rgba16float decode |
| `src/loader-hdr/load-hdr.ts` | ~102 lines | HDR environment loader orchestrator, deferred background builder |
| `src/loader-hdr/hdr-parser.ts` | ~218 lines | RGBE CPU parser, RLE scanline decoder, equirect SH computation |
| `src/loader-hdr/hdr-ibl-pipeline.ts` | ~400 lines | GPU compute: equirect→cubemap, GGX prefilter, BRDF LUT generation |
| `src/loader-babylon/load-babylon.ts` | ~428 lines | .babylon JSON parser, standard materials, lights, mesh upload |
| `src/loader-skybox/load-skybox.ts` | ~96 lines | Cube texture loader + deferred skybox registration |
| `src/loader-skybox/skybox-renderable.ts` | ~32 lines | Skybox renderable builder wrapping skybox-cubemap material |
| `src/texture/generate-mipmaps.ts` | ~141 lines | GPU mipmap blit (shared utility) |
