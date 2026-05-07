# Module: Background & Skybox
> Package paths:
> - `packages/babylon-lite/src/material/pbr/background-material.ts` — Skybox material + cubemap skybox material factory + geometry generation
> - `packages/babylon-lite/src/material/pbr/background-renderable.ts` — Skybox + Ground → Renderables orchestrator, scene size computation
> - `packages/babylon-lite/src/material/pbr/background-ground.ts` — Ground material, geometry, texture loading, UBO
> - `packages/babylon-lite/src/material/pbr/background-dds-skybox.ts` — DDS cubemap skybox renderable
> - `packages/babylon-lite/src/material/pbr/background-dds-environment.ts` — scene-scoped DDS skybox + ground orchestration
> - `packages/babylon-lite/src/material/pbr/background-hdr-skybox.ts` — HDR cubemap skybox renderable
> - `packages/babylon-lite/src/material/standard/skybox-cubemap.ts` — CubeMap skybox for StandardMaterial scenes
> - `packages/babylon-lite/src/texture/cube-texture.ts` — 6-face cube texture loader
>
> Shaders:
> - `packages/babylon-lite/shaders/skybox.vertex.wgsl`, `skybox.fragment.wgsl` — Environment solid-color skybox
> - `packages/babylon-lite/shaders/skybox-dds.vertex.wgsl`, `skybox-dds.fragment.wgsl` — DDS cubemap skybox
> - `packages/babylon-lite/shaders/skybox-hdr.fragment.wgsl` — HDR cubemap skybox fragment
> - `packages/babylon-lite/shaders/background.vertex.wgsl`, `background.ground.fragment.wgsl` — Ground plane
> - `packages/babylon-lite/shaders/skybox-cubemap.vertex.wgsl`, `skybox-cubemap.fragment.wgsl` — CubeMap skybox

## Purpose

This module provides five related rendering sub-systems for scene backgrounds:

1. **Solid-Color Skybox Material** (`createSkyboxMaterial`) — Renders the scene background behind all other objects. Uses a box mesh (24v/36i) but outputs a pre-computed clearColor directly from the UBO — the BJS skybox cubemap at max-mip through the image pipeline is indistinguishable from clearColor at default settings.

2. **DDS Cubemap Skybox** (`buildDdsSkyboxRenderable`) — Lazy-loaded skybox that loads `backgroundSkybox.dds` (rgba16float DDS cubemap) and renders it with BJS image processing (exposure, contrast, tonemapping). Uses the shared `CubemapSkyboxMaterial` factory. Tree-shaken from scenes that don't use DDS skyboxes.

3. **HDR Cubemap Skybox** (`buildHdrSkyboxRenderable`) — Lazy-loaded skybox for HDR panorama environments. Samples the specular cubemap (from `EnvironmentTextures`) with image processing. Tree-shaken from scenes that don't use HDR skyboxes.

4. **Ground Material** (`buildGroundRenderable` in `background-ground.ts`) — Renders a translucent ground plane with a diffuse texture, opacity Fresnel, premultiplied alpha blending, and image processing. Matches BJS `BackgroundMaterial` with `DIFFUSE + DIFFUSEHASALPHA + OPACITYFRESNEL + PREMULTIPLYALPHA`. Lazy-loaded and tree-shaken from scenes with `skipGround: true`.

5. **Skybox CubeMap Material** (`buildSkyboxCubeMapGPU`) — Renders a 6-face image cubemap (loaded via `loadCubeTexture`) for StandardMaterial-based scenes. Uses the canonical scene UBO layout. Renders backfaces (cullMode = none). Includes fog support.

6. **Cube Texture Loader** (`loadCubeTexture`) — Loads 6 face images (`_px`, `_nx`, `_py`, `_ny`, `_pz`, `_nz`) and generates mipmaps.

## BJS Ground Architecture (verified via Spector.GPU)

The ground implementation was reverse-engineered by capturing BJS and Lite frames side-by-side with Spector.GPU and comparing shaders, pipelines, textures, and UBO contents.

### Key discovery: the ground is NOT a box with cubemap reflection

Early implementations incorrectly used a 24-vertex/36-index box with a cubemap reflection shader. Spector.GPU captures revealed:

- **BJS ground = `CreatePlane("BackgroundPlane", {size: 15})` with `sideOrientation = BACKSIDE`**
- **4 vertices, 6 indices** (quad, not box!)
- The 36-index draw call visible in captures is the **skybox**, not the ground — misidentified by vertex/index count
- The ground shader has NO `REFLECTION` define — it uses `DIFFUSE + OPACITYFRESNEL + PREMULTIPLYALPHA`

### BJS ground diffuse texture (`backgroundGround.png`)

BJS loads `https://assets.babylonjs.com/core/environments/backgroundGround.png`:
- **1024×1024**, white RGB (255,255,255), radial alpha gradient
- Center alpha = 255, edge alpha = 0
- This texture drives the spatial variation in ground opacity — without it, the ground has uniform alpha

The texture URL is **not hardcoded in the engine**. Client code passes it via `loadEnvironment()` options:

```typescript
await loadEnvironment(scene, envUrl, {
  groundTextureUrl: 'https://assets.babylonjs.com/core/environments/backgroundGround.png',
});
```

If no URL is provided, a 1×1 white pixel fallback is used (ground alpha driven by fresnel only).

### Ground alpha pipeline

The final pixel alpha is computed as:

```
alpha = materialAlpha(0.9) × textureAlpha × fadeFactor²
```

Where `fadeFactor = clamp(dot(normalW, viewDir) / 0.1, 0, 1)` (opacity fresnel).

**Camera-dependent behavior:**
- **Grazing angle** (camera at Y≈0, e.g. Scene 1): viewAngle → 0, fadeFactor → 0, alpha → 0 → ground invisible → clearColor shows through
- **Elevated camera** (camera at Y=1.67, e.g. Scene 7): viewAngle > 0.1, fadeFactor → 1, alpha → `0.9 × textureAlpha` → ground partially visible with spatial variation from radial texture

### Ground world matrix

The quad is built in the XY plane and rotated 90° around X to lie flat in XZ:

```
| 1    0       0       0      |
| 0    ε      -1      -0.01   |    ε = 2.220446e-16 (≈0)
| 0    1       ε       0      |
| 0    0       0       1      |
```

Local normal `(0,0,1)` transforms to world `(0,1,0)` (pointing UP). Y offset = `-0.009781629778444767`.

## Public API Surface

### `load-env.ts` (entry point)

```typescript
export async function loadEnvironment(
  scene: SceneContext,
  url: string,
  options: {
    brdfUrl: string;
    groundTextureUrl?: string;
    skipSkybox?: boolean;
    skipGround?: boolean;
    skyboxUrl?: string;
    skyboxSize?: number;
  },
): Promise<EnvironmentTextures>;
```

The `groundTextureUrl` option is passed through to the ground builder, which fetches and uploads the texture to GPU. Standard `loadEnvironment()` backgrounds keep BJS-style background dithering enabled.

### `background-material.ts`

```typescript
// --- Solid-Color Skybox ---
export interface SkyboxMaterial {
  getPipeline(device: GPUDevice, format: GPUTextureFormat, msaaSamples: number): GPURenderPipeline;
  createBindGroup(device: GPUDevice, meshUBO: GPUBuffer, env: EnvironmentTextures): GPUBindGroup;
}
export function createSkyboxMaterial(sceneBindGroupLayout: GPUBindGroupLayout): SkyboxMaterial;

// --- Cubemap Skybox (shared by DDS + HDR variants) ---
export interface CubemapSkyboxMaterial {
  getPipeline(device: GPUDevice, format: GPUTextureFormat, msaaSamples: number): GPURenderPipeline;
  createBindGroup(device: GPUDevice, meshUBO: GPUBuffer, cubeView: GPUTextureView, cubeSampler: GPUSampler): GPUBindGroup;
}
export function createCubemapSkyboxMaterial(
  sceneBindGroupLayout: GPUBindGroupLayout, label: string, vertCode: string, fragCode: string,
): CubemapSkyboxMaterial;

// --- Geometry ---
export function createSkyboxBuffers(device: GPUDevice, S?: number): {
  posBuffer: GPUBuffer; idxBuffer: GPUBuffer; idxCount: number;
};
export function createBuf(device: GPUDevice, data: ArrayBufferView, usage: GPUBufferUsageFlags): GPUBuffer;
export function buildSkyboxWorldMatrix(rootPosition: [number, number, number]): Mat4;
```

### `background-renderable.ts`

```typescript
export interface BackgroundRenderableOptions {
  skipSkybox?: boolean;   // Skip solid-color skybox (e.g. caller provides HDR/DDS skybox)
  skipGround?: boolean;   // Skip ground plane rendering
  skyboxSize?: number;    // Skybox size (matches BJS createDefaultEnvironment option)
}

export async function buildBackgroundRenderables(
  scene: SceneContext,
  envTextures: EnvironmentTextures,
  sceneBindGroupLayout: GPUBindGroupLayout,
  sceneBindGroup: GPUBindGroup,
  groundTextureUrl?: string,
  options?: BackgroundRenderableOptions,
  groundImagePromise?: Promise<ImageBitmap>,
): Promise<Renderable[]>;

export function computeSceneSize(
  scene: SceneContext,
  userSkyboxSize?: number,
): { groundSize: number; skyboxSize: number; rootPosition: [number, number, number] };

export function computeSkyboxGeometry(
  scene: SceneContext,
  userSkyboxSize?: number,
): { skyHalfSize: number; rootPosition: [number, number, number] };
```

### `background-ground.ts`

```typescript
/** Build the ground renderable for a PBR environment scene. */
export async function buildGroundRenderable(
  device: GPUDevice,
  sceneBindGroupLayout: GPUBindGroupLayout,
  format: GPUTextureFormat,
  msaaSamples: number,
  sceneBindGroup: GPUBindGroup,
  groundSize: number,
  rootPosition: [number, number, number],
  primaryColor: [number, number, number],
  groundTextureUrl?: string,
  groundImagePromise?: Promise<ImageBitmap>,
  enableNoise?: boolean,
): Promise<Renderable>;
```

### `background-dds-skybox.ts`

```typescript
/** Build a DDS cube skybox as a complete Renderable (order 0). */
export async function buildDdsSkyboxRenderable(
  scene: SceneContext,
  sceneBindGroupLayout: GPUBindGroupLayout,
  sceneBindGroup: GPUBindGroup,
  skyboxTextureUrl?: string,  // default: backgroundSkybox.dds from BJS CDN
  skyboxSize?: number,
  enableNoise?: boolean,
): Promise<Renderable>;
```

### `background-dds-environment.ts`

```typescript
export function addDdsEnvironmentBackground(
  scene: SceneContext,
  options: {
    skyboxUrl: string;
    groundTextureUrl: string;
    skyboxSize: number;
    enableNoise?: boolean; // Default true; matches BJS BackgroundMaterial.enableNoise
  },
): void;
```

This helper only orchestrates the existing DDS skybox and ground builders. Scene 112 uses it with `enableNoise: false` after loading environment lighting with `skipSkybox` and `skipGround`, avoiding duplicated skybox/ground implementations while keeping the no-noise path scene-scoped.

### `background-hdr-skybox.ts`

```typescript
/** Build an HDR cubemap skybox as a complete Renderable (order 0). */
export function buildHdrSkyboxRenderable(
  scene: SceneContext,
  envTextures: EnvironmentTextures,
  sceneBindGroupLayout: GPUBindGroupLayout,
  sceneBindGroup: GPUBindGroup,
  skyboxSize?: number,
): Renderable;
```

### `skybox-cubemap.ts`

```typescript
export interface SkyboxCubeMapGPU {
  pipeline: GPURenderPipeline;
  sceneBindGroup: GPUBindGroup;
  meshBindGroup: GPUBindGroup;
  sceneUBO: GPUBuffer;
  meshUBO: GPUBuffer;
}

export function buildSkyboxCubeMapGPU(
  device: GPUDevice,
  format: GPUTextureFormat,
  msaaSamples: number,
  sceneUBO: GPUBuffer,
  worldMatrix: Float32Array,
  cubeView: GPUTextureView,
  cubeSampler: GPUSampler,
): SkyboxCubeMapGPU;
```

### `cube-texture.ts`

```typescript
export async function loadCubeTexture(
  device: GPUDevice,
  baseUrl: string,
  extension?: string,  // default: '.jpg'
): Promise<{ texture: GPUTexture; view: GPUTextureView; sampler: GPUSampler }>;
```

## Pipeline Configuration

### Skybox Pipeline (Solid-Color — Environment)

| Setting | Value |
|---|---|
| Vertex buffers | 1: position (`float32x3`, stride 12) |
| Topology | `triangle-list` |
| Cull mode | `back` |
| Front face | `ccw` |
| Depth compare | `less-equal` |
| Depth write | **`false`** |
| MSAA | `count = msaaSamples` |
| Blend | None |

### Cubemap Skybox Pipeline (DDS + HDR variants)

Both DDS and HDR cubemap skyboxes use the same pipeline configuration via `createCubemapSkyboxMaterial` — only the shader sources differ.

| Setting | Value |
|---|---|
| Vertex buffers | 1: position (`float32x3`, stride 12) |
| Topology | `triangle-list` |
| Cull mode | `back` |
| Front face | `ccw` |
| Depth compare | `less-equal` |
| Depth write | **`false`** |
| MSAA | `count = msaaSamples` |
| Blend | None |

### Ground Pipeline

| Setting | Value |
|---|---|
| Vertex buffers | 3: position (`float32x3`, stride 12), normal (`float32x3`, stride 12), uv (`float32x2`, stride 8) |
| Topology | `triangle-list` |
| Cull mode | `back` |
| Front face | `ccw` |
| Depth compare | `less-equal` |
| Depth write | **`false`** |
| MSAA | `count = msaaSamples` |
| Blend | Premultiplied alpha: `src=one, dst=one-minus-src-alpha` (both color and alpha) |

### Skybox CubeMap Pipeline (StandardMaterial scenes)

| Setting | Value |
|---|---|
| Vertex buffers | 2: position (`float32x3`, stride 12), normal (`float32x3`, stride 12) |
| Topology | `triangle-list` |
| Cull mode | **`none`** (sees inside of box) |
| Front face | `ccw` |
| Depth compare | `less-equal` |
| Depth write | `true` |
| MSAA | `count = msaaSamples` |
| Blend | None |

### Bind Group Layouts

**Skybox Solid-Color (Group 1)**:

| Binding | Visibility | Type | Resource |
|---|---|---|---|
| 0 | VERTEX \| FRAGMENT | Uniform buffer | Mesh UBO (96 bytes: world + primaryColor + skyOutputColor) |

**Cubemap Skybox — DDS + HDR (Group 1)** (shared layout via `createCubemapSkyboxMaterial`):

| Binding | Visibility | Type | Resource |
|---|---|---|---|
| 0 | VERTEX \| FRAGMENT | Uniform buffer | Mesh UBO (see variant-specific sizes below) |
| 1 | FRAGMENT | texture_cube | Cubemap texture (DDS or specular env cube) |
| 2 | FRAGMENT | sampler (filtering) | Cubemap sampler |

**Ground (Group 1)**:

| Binding | Visibility | Type | Resource |
|---|---|---|---|
| 0 | VERTEX \| FRAGMENT | Uniform buffer | Mesh UBO (96 bytes: world + primaryColor + alpha + backgroundCenter) |
| 1 | FRAGMENT | texture_2d | Ground diffuse texture (loaded from URL) |
| 2 | FRAGMENT | sampler (filtering) | Ground texture sampler (bilinear) |

**Skybox CubeMap (Group 1)**:

| Binding | Visibility | Type | Resource |
|---|---|---|---|
| 0 | VERTEX | Uniform buffer | Mesh UBO (world matrix only) |
| 1 | FRAGMENT | texture_cube | Cube texture |
| 2 | FRAGMENT | sampler | Cube sampler |

## Internal Architecture

### Skybox Geometry

24 vertices, 36 indices — a box mesh. The half-size `S` defaults to 15 but is dynamically computed from scene bounds via `computeSkyboxGeometry()`.

```
Positions (8 unique corners, but 24 vertices for separate face normals):
  Front:  ( S,-S, S), (-S,-S, S), (-S, S, S), ( S, S, S)
  Back:   ( S, S,-S), (-S, S,-S), (-S,-S,-S), ( S,-S,-S)
  Right:  ( S, S,-S), ( S,-S,-S), ( S,-S, S), ( S, S, S)
  Left:   (-S, S, S), (-S,-S, S), (-S,-S,-S), (-S, S,-S)
  Top:    (-S, S, S), (-S, S,-S), ( S, S,-S), ( S, S, S)
  Bottom: ( S,-S, S), ( S,-S,-S), (-S,-S,-S), (-S,-S, S)

Indices (36, triangle-list, uint16):
  Per face: (2,1,0, 3,2,0)
```

### Scene Size Computation (`computeSceneSize`)

Matches BJS `EnvironmentHelper._setupSizes()` with `sizeAuto=true`:

1. Compute world-space AABB of all meshes (offset local bounds by world translation)
2. Compute scene diagonal length: `sqrt(dx² + dy² + dz²)`
3. Start with `groundSize = 15, skyboxSize = userSkyboxSize ?? 20`
4. If camera has `upperRadiusLimit`: use `upperRadiusLimit × 2` as base
5. If diagonal > groundSize: `groundSize = diagonal × 2, skyboxSize = groundSize`
6. `groundSize *= 1.1`, `skyboxSize *= 1.5`
7. `rootPosition = [centerX, minY − 0.00001, centerZ]`

### Skybox World Matrix (`buildSkyboxWorldMatrix`)

Identity matrix translated to `rootPosition`:
```
| 1  0  0  rootX |
| 0  1  0  rootY |
| 0  0  1  rootZ |
| 0  0  0  1     |
```

### Ground Geometry (in `background-ground.ts`)

4 vertices, 6 indices — a flat quad in the XY plane, extents ±(groundSize/2).

```
Positions: (-h,-h,0), (h,-h,0), (h,h,0), (-h,h,0)    where h = groundSize/2
Normals:   (0,0,1) for all 4 vertices (BACKSIDE — flipped from default -Z)
UVs:       (0,0), (1,0), (1,1), (0,1)
Indices:   (0,2,1, 0,3,2) (BACKSIDE winding — swapped from FRONTSIDE 0,1,2,0,2,3)
```

The ground is rotated 90° around X by its world matrix to lie flat in the XZ plane.
Local normal `(0,0,+1)` → world normal `(0,+1,0)` (pointing UP).

### Mesh UBO Layout — Solid-Color Skybox (96 bytes)

| Offset (bytes) | Size | WGSL Type | Field |
|---|---|---|---|
| 0 | 64 | `mat4x4<f32>` | `world` |
| 64 | 12 | `vec3<f32>` | `primaryColor` |
| 76 | 4 | `f32` | `_pad` |
| 80 | 12 | `vec3<f32>` | `skyOutputColor` (pre-computed sRGB clearColor) |
| 92 | 4 | `f32` | `_pad` |

### Mesh UBO Layout — DDS Skybox (96 bytes)

| Offset (bytes) | Size | WGSL Type | Field |
|---|---|---|---|
| 0 | 64 | `mat4x4<f32>` | `world` |
| 64 | 12 | `vec3<f32>` | `primaryColor` |
| 76 | 4 | `f32` | `exposureLinear` |
| 80 | 4 | `f32` | `contrast` |
| 84 | 12 | — | `_pad` |

### Mesh UBO Layout — HDR Skybox (112 bytes)

| Offset (bytes) | Size | WGSL Type | Field |
|---|---|---|---|
| 0 | 64 | `mat4x4<f32>` | `world` |
| 64 | 12 | `vec3<f32>` | `primaryColor` |
| 76 | 4 | `f32` | `_pad` |
| 80 | 12 | `vec3<f32>` | `skyOutputColor` (clearColor for fallback) |
| 92 | 4 | `f32` | `_pad` |
| 96 | 4 | `f32` | `exposureLinear` |
| 100 | 4 | `f32` | `contrast` |
| 104 | 8 | — | `_pad` |

### Mesh UBO Layout — Ground (96 bytes, in `background-ground.ts`)

| Offset (bytes) | Size | WGSL Type | Field |
|---|---|---|---|
| 0 | 64 | `mat4x4<f32>` | `world` |
| 64 | 12 | `vec3<f32>` | `primaryColor` |
| 76 | 4 | `f32` | `alpha` (default: 0.9, matches BJS `groundOpacity`) |
| 80 | 12 | `vec3<f32>` | `backgroundCenter` (default: origin) |
| 92 | 4 | `f32` | `_pad` |

### Mesh UBO Layout — CubeMap Skybox (64 bytes)

| Offset (bytes) | Size | WGSL Type | Field |
|---|---|---|---|
| 0 | 64 | `mat4x4<f32>` | `world` |

### DDS Skybox Architecture (`background-dds-skybox.ts`)

Default DDS URL: `https://assets.babylonjs.com/core/environments/backgroundSkybox.dds`

Pipeline:
1. `computeSkyboxGeometry(scene, skyboxSize)` → `skyHalfSize`, `rootPosition`
2. `buildSkyboxWorldMatrix(rootPosition)` → identity + translation
3. `createSkyboxBuffers(device, skyHalfSize)` → box geometry
4. `loadDdsCube(device, url)` → fetch DDS, parse header, upload all mip levels, create cube view + sampler
5. `createCubemapSkyboxMaterial(sceneBindGroupLayout, "skybox-dds", vertCode, fragCode)` → shared material factory
6. Create UBO with world, primaryColor, exposure, contrast
7. Return `Renderable` with order 0

DDS cube texture loading:
- Parse DDS header: `Int32Array(buf, 0, 32)` — width, height, mipCount
- Handle DX10 extended header offset
- Upload all mip levels per face (face-major layout, `rgba16float`, 8 bytes/pixel)
- Sampler: linear mag/min/mipmap, clamp-to-edge, maxAnisotropy=4

### HDR Skybox Architecture (`background-hdr-skybox.ts`)

Samples the specular cubemap from `EnvironmentTextures` (already loaded by `loadHdrEnvironment`).

Pipeline:
1. `computeSkyboxGeometry(scene, skyboxSize)` → `skyHalfSize`, `rootPosition`
2. `buildSkyboxWorldMatrix(rootPosition)` → identity + translation
3. `createSkyboxBuffers(device, skyHalfSize)` → box geometry
4. `createCubemapSkyboxMaterial(sceneBindGroupLayout, "skybox-hdr", vertCode, fragCode)` → shared material factory
5. Create UBO with world, primaryColor, skyOutputColor (clearColor), exposure, contrast
6. Bind `envTextures.specularCubeView` + `envTextures.cubeSampler`
7. Return `Renderable` with order 0

### Background Renderable Orchestrator (`background-renderable.ts`)

Orchestrates the creation of background renderables:
1. If `!options.skipSkybox`: creates solid-color skybox via `createSkyboxMaterial()`
2. If `!options.skipGround`: dynamically imports `background-ground.js` → `buildGroundRenderable(..., enableNoise)`
3. Ground is dynamically imported to enable tree-shaking for scenes without ground

Both DDS and HDR skybox callers (in `load-env.ts`, `load-hdr.ts`, `load-dds-env.ts`) use `buildBackgroundRenderables()` with `skipSkybox: true` when they provide their own cubemap skybox.

### Ground Texture Loading (in `background-ground.ts`)

The ground diffuse texture is loaded at runtime from a client-provided URL:

1. Caller provides `groundTextureUrl` and/or pre-fetched `groundImagePromise`
2. If promise provided: await it. Otherwise: `fetch(url)` → `createImageBitmap(blob, { premultiplyAlpha: 'none' })`
3. `copyExternalImageToTexture()` to upload to GPU as `rgba8unorm`
4. If no URL provided: creates a 1×1 white pixel fallback

The standard BJS ground texture is `backgroundGround.png` (1024×1024, white RGB, radial alpha gradient).

### Cube Texture Loading

1. Construct 6 URLs: `${baseUrl}_px${ext}`, `_nx`, `_py`, `_ny`, `_pz`, `_nz`.
2. Fetch all 6 in parallel → `createImageBitmap` with `colorSpaceConversion: 'none'`.
3. Create GPU texture: `[size, size, 6]`, format `rgba8unorm`, dimension `2d`, full mip chain.
4. Copy each face bitmap to the corresponding array layer.
5. Generate mipmaps via GPU blit pass (fullscreen quad sampling previous mip → next mip).
6. Create cube view (`dimension: 'cube'`) and trilinear sampler.

### Render Order

| Renderable | Order | Notes |
|---|---|---|
| Skybox | 0 | Renders first (behind everything), writes depth |
| PBR meshes | 100 (default) | Opaque objects |
| Ground | 200 | Renders last (transparent), no depth write, alpha blend |

## Shader Logic

### Skybox Fragment (`skybox.fragment.wgsl`)

Currently outputs a pre-computed clearColor from the mesh UBO. The BJS skybox cubemap sampled at max-mip through the full image processing pipeline produces output indistinguishable from clearColor at default settings.

```
output = mesh.skyOutputColor  // pre-computed sRGB value
```

> **Note**: This is a visual shortcut. A proper implementation would sample the cubemap and run the image processing pipeline. The shortcut works because at default PBR environment settings (`primaryColor = #212121`, `exposure = 0.8`, `contrast = 1.2`), the processed cubemap output equals clearColor to within dithering precision.

### Ground Fragment (`background.ground.fragment.wgsl`)

Verified against BJS shd_16 via Spector.GPU capture comparison.

```
// Sample diffuse texture (BJS backgroundGround.png: white RGB, radial alpha)
diffuseMap = textureSample(groundTexture, groundSampler, uv)

// Base color from texture tinted by primaryColor
diffuseColor = diffuseMap.rgb
finalColor = max(diffuseColor, 0) × mesh.primaryColor

// Alpha = material alpha × texture alpha
finalAlpha = mesh.alpha × diffuseMap.a

// OPACITYFRESNEL (BJS shd_16 lines 367-370)
backgroundCenter = mesh.backgroundCenter  // default: origin
viewAngle = dot(normalW, normalize(cameraPosition - backgroundCenter))
fadeFactor = clamp(viewAngle / 0.1, 0, 1)
finalAlpha *= fadeFactor²

// Image processing (exposure, tonemapping, gamma, contrast — preserves alpha)
color = applyImageProcessing(vec4(finalColor, finalAlpha))

// PREMULTIPLYALPHA (BJS shd_16 line 373)
color.rgb *= color.a

// Dithering (variance = 0.5)
color.rgb += dither(worldPos.xy, 0.5)
```

### CubeMap Skybox Fragment (`skybox-cubemap.fragment.wgsl`)

```
lookupDir = normalize(positionLocal)     // object-space position as direction
color = textureSample(cubeTexture, cubeSampler, lookupDir)

// Apply fog (if enabled)
if fogMode > 0:
  fogCoeff = calcFogFactor(vFogDistance)
  color.rgb = mix(fogColor, color.rgb, fogCoeff)
```

## Babylon.js Equivalence Map

| Babylon Lite | Babylon.js |
|---|---|
| `loadEnvironment(scene, url, { groundTextureUrl })` | `scene.createDefaultEnvironment()` (loads env + ground texture internally) |
| `createSkyboxMaterial()` | `BackgroundMaterial` with `REFLECTIONMAP_SKYBOX` (solid fallback) |
| `createCubemapSkyboxMaterial()` | `BackgroundMaterial` with actual cubemap sampling |
| `buildDdsSkyboxRenderable()` | `BackgroundMaterial` with `backgroundSkybox.dds` cubemap |
| `buildHdrSkyboxRenderable()` | `BackgroundMaterial` with HDR cubemap from `HDRCubeTexture` |
| `buildGroundRenderable()` | `BackgroundMaterial` ground mesh with `DIFFUSE + OPACITYFRESNEL + PREMULTIPLYALPHA` |
| `createSkyboxBuffers(S)` | `BABYLON.BoxBuilder` (±S extents skybox, 24v/36i) |
| `createGroundBuffers(groundSize)` | `BABYLON.PlaneBuilder` with `BACKSIDE` (4v/6i) |
| `computeSceneSize()` | `EnvironmentHelper._getSceneSize()` + `_setupSizes()` |
| `computeSkyboxGeometry()` | `EnvironmentHelper._setupSizes()` with `sizeAuto=true` |
| `buildSkyboxWorldMatrix()` | `EnvironmentHelper._setupSkyboxMaterial()` world matrix |
| `buildSkyboxCubeMapGPU()` | `StandardMaterial` + `CubeTexture(SKYBOX_MODE)` |
| `loadCubeTexture()` | `new BABYLON.CubeTexture(url, scene)` |
| `primaryColor` | `BackgroundMaterial.primaryColor` (#212121 linear → `[0.087, 0.087, 0.212]`) |
| Ground Y offset `minY − 0.00001` | Babylon's computed `sceneSize / rootPosition` |
| `mesh.alpha = 0.9` | `BackgroundMaterial.alpha` (default ground opacity) |
| `mesh.backgroundCenter` | `BackgroundMaterial._primaryColor` (fresnel origin) |
| Opacity Fresnel `viewAngle / 0.1` | `BackgroundMaterial.opacityFresnel` (start=0.1) |
| Ground diffuse texture (URL) | `backgroundGround.png` loaded by `EnvironmentHelper` |
| Ground blend `src=one, dst=one-minus-src-alpha` | Premultiplied alpha blend (BJS engine auto-set) |
| `dither(seed, 0.5)` | `BackgroundMaterial.enableNoise` |
| `skyOutputColor` UBO field | BJS cubemap sampled at max-mip (produces same result) |
| DDS skybox `backgroundSkybox.dds` | BJS `createDefaultEnvironment` skybox DDS cubemap |
| HDR skybox samples `specularCubeView` | BJS `HDRCubeTexture` skybox rendering |
| CubeMap skybox `cullMode: 'none'` | `material.backFaceCulling = false` |

## Dependencies

- **`background-material.ts` imports**: `EnvironmentTextures` from `../../loader-env/load-env.js`; `Mat4` from `../../math/types.js`; shader sources via `?raw`; render/pipeline helpers; `WGSL_DITHER` from `../../shader/wgsl-helpers.js`.
- **`background-renderable.ts` imports**: `SceneContext` from `../../scene/scene.js`; `EngineInternal` from `../../engine/engine.js`; `EnvironmentTextures` from `../../loader-env/load-env.js`; `Mat4` from `../../math/types.js`; `Renderable` from `../../render/renderable.js`; `createSkyboxMaterial`, `createSkyboxBuffers`, `buildSkyboxWorldMatrix` from `./background-material.js`; dynamic import of `./background-ground.js`.
- **`background-ground.ts` imports**: `Mat4` from `../../math/types.js`; `Renderable` from `../../render/renderable.js`; `getOrCreateSampler` from `../../resource/gpu-pool.js`; shader sources via `?raw`; `createBuf` from `./background-material.js`; `SCENE_UBO_WGSL` from `../../shader/scene-uniforms.js`; `WGSL_IMAGE_PROCESSING`, `WGSL_DITHER` from `../../shader/wgsl-helpers.js`.
- **`background-dds-skybox.ts` imports**: `SceneContext` from `../../scene/scene.js`; `EngineInternal` from `../../engine/engine.js`; `Renderable` from `../../render/renderable.js`; `getOrCreateSampler` from `../../resource/gpu-pool.js`; `computeSkyboxGeometry` from `./background-renderable.js`; `createSkyboxBuffers`, `buildSkyboxWorldMatrix`, `createCubemapSkyboxMaterial` from `./background-material.js`; `SCENE_UBO_WGSL` from `../../shader/scene-uniforms.js`; `WGSL_DITHER` from `../../shader/wgsl-helpers.js`; shader sources via `?raw`.
- **`background-hdr-skybox.ts` imports**: `SceneContext` from `../../scene/scene.js`; `EngineInternal` from `../../engine/engine.js`; `EnvironmentTextures` from `../../loader-env/load-env.js`; `Renderable` from `../../render/renderable.js`; `createSkyboxBuffers`, `buildSkyboxWorldMatrix`, `createCubemapSkyboxMaterial` from `./background-material.js`; `computeSkyboxGeometry` from `./background-renderable.js`; shader sources via `?raw`; `SCENE_UBO_WGSL` from `../../shader/scene-uniforms.js`.
- **`skybox-cubemap.ts` imports**: Shader sources via `?raw`.
- **`cube-texture.ts` imports**: None (standalone).
- **Depended on by**: `load-env.ts` (deferred builder), `load-hdr.ts` (dynamic imports of `background-hdr-skybox.js` and `background-renderable.js`), `load-dds-env.ts` (uses `buildBackgroundRenderables`), `load-skybox.ts` (creates cubemap skybox).

## Test Specification

| Test | Description |
|---|---|
| `createSkyboxBuffers` | 24 verts (72 floats), 36 indices |
| `createSkyboxBuffers custom size` | Verify positions scale with `S` parameter |
| `createGroundBuffers` | 4 verts, 4 normals, 4 UVs, 6 indices |
| `skybox pipeline depth write false` | Verify solid-color skybox depth config |
| `cubemap skybox pipeline depth write false` | Verify DDS/HDR skybox depth config |
| `ground pipeline depth write false` | Verify depth write disabled |
| `ground pipeline blend premultiplied` | src=one, dst=one-minus-src-alpha |
| `ground pipeline 3 vertex buffers` | position + normal + uv |
| `ground bind group has texture` | Binding 1 = texture_2d, binding 2 = sampler |
| `ground fallback texture 1×1 white` | No URL → 1×1 RGBA(255,255,255,255) |
| `skybox cubemap cull mode none` | Verify no culling for inside-box rendering |
| `loadCubeTexture loads 6 faces` | Verify 6 URLs constructed with correct suffixes |
| `loadCubeTexture mip count` | `floor(log2(size)) + 1` |
| `computeSceneSize empty scene` | Returns defaults: groundSize=15, skyboxSize=20 |
| `computeSceneSize with meshes` | Diagonal > 15 → groundSize=diagonal×2.2, skyboxSize=×1.5 |
| `buildSkyboxWorldMatrix` | Identity + rootPosition translation |
| `DDS skybox loads default URL` | Fetches backgroundSkybox.dds |
| `DDS skybox UBO layout` | world + primaryColor + exposure + contrast = 96 bytes |
| `HDR skybox uses specularCubeView` | Binds envTextures cube |
| `HDR skybox UBO layout` | 112 bytes with exposure + contrast fields |
| `buildBackgroundRenderables skipSkybox` | Only ground returned |
| `buildBackgroundRenderables skipGround` | Only skybox returned |
| `dither variance` | Output varies by ±0.5/255 |
| `opacity fresnel at grazing` | fadeFactor → 0 at edge |
| `opacity fresnel head-on` | fadeFactor → 1 |
| Scene 1 full-image MAD ≤ 1 | Ground invisible (grazing), clearColor match |
| Scene 7 full-image MAD ≤ 2 | Ground visible (elevated camera), texture spatial variation |

## File Manifest

| File | Size | Purpose |
|---|---|---|
| `src/material/pbr/background-material.ts` | ~184 lines | Solid-color skybox material, cubemap skybox material factory, skybox geometry, shared buffer helpers, skybox world matrix |
| `src/material/pbr/background-renderable.ts` | ~203 lines | Skybox + Ground orchestrator, scene size computation, `computeSkyboxGeometry` |
| `src/material/pbr/background-ground.ts` | ~246 lines | Ground material factory, ground geometry, ground UBO, ground texture loader |
| `src/material/pbr/background-dds-skybox.ts` | ~130 lines | DDS cubemap skybox renderable, DDS cube texture loader, DDS mesh UBO |
| `src/material/pbr/background-hdr-skybox.ts` | ~84 lines | HDR cubemap skybox renderable, HDR mesh UBO |
| `src/material/standard/skybox-cubemap.ts` | ~104 lines | CubeMap skybox pipeline + bind groups |
| `src/texture/cube-texture.ts` | ~141 lines | 6-face cube texture loader with mipmap generation |
| `shaders/skybox.vertex.wgsl` | ~38 lines | Local position passthrough for cubemap lookup |
| `shaders/skybox.fragment.wgsl` | ~91 lines | Outputs pre-computed clearColor from UBO |
| `shaders/skybox-dds.vertex.wgsl` | ~38 lines | DDS skybox vertex shader (position → local direction) |
| `shaders/skybox-dds.fragment.wgsl` | ~91 lines | DDS cubemap sample + image processing |
| `shaders/skybox-hdr.fragment.wgsl` | ~91 lines | HDR cubemap sample + image processing |
| `shaders/background.vertex.wgsl` | ~48 lines | World transform, normal, UV passthrough for ground |
| `shaders/background.ground.fragment.wgsl` | ~104 lines | Diffuse texture sampling, opacity Fresnel, premultiplied alpha, image processing |
| `shaders/skybox-cubemap.vertex.wgsl` | ~38 lines | Object-space position for cube lookup + fog distance |
| `shaders/skybox-cubemap.fragment.wgsl` | ~58 lines | Cube texture sample + fog |
