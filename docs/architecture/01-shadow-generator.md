# Module: Shadow Generator
> Package path: `packages/babylon-lite/src/shadow/`

## Purpose

Implements two shadow mapping techniques for different light types:

1. **Exponential Shadow Mapping (ESM)** with two-pass Gaussian blur for **directional lights** — produces a blurred shadow texture that the main material pass samples. Pipeline per-frame: (1) render shadow casters from the light's perspective into an ESM depth texture, (2) horizontal Gaussian blur, (3) vertical Gaussian blur.

2. **Percentage Closer Filtering (PCF)** for **spot lights** — renders casters into a depth-only texture; the main-pass fragment shader samples with a hardware comparison sampler (5×5 bilinear PCF). No blur passes needed — saves 2 draw calls and 2 GPU textures vs ESM.

Both generators share caster infrastructure from `shadow-base.ts` and return the same `ShadowGenerator` interface, so the downstream render pipeline is shadow-technique-agnostic.

### Babylon.js Configuration Equivalence

**ESM generator** matches:
- `useBlurExponentialShadowMap = true`, `useKernelBlur = true`, `blurKernel = 64`
- `mapSize = 1024`, `depthScale = 50`, `bias = 0.00005`

**PCF generator** matches:
- `usePercentageCloserFiltering = true` (SM_PCF / shadow5 quality)
- `mapSize = 512`, `bias = 0.00005`

---

## Public API Surface

### Shared Base (`shadow-base.ts`)

```typescript
export interface ShadowCaster {
  positionBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  worldMatrix: Float32Array;   // 16-element column-major 4×4
  meshUBO: GPUBuffer;
  bindGroup: GPUBindGroup;
  _mesh: Mesh;
  _lastWorldVersion: number;
}

/** Build caster list from meshes, creating per-caster UBOs and bind groups. */
export function buildCasters(
  device: GPUDevice,
  meshes: Mesh[],
  meshBGL: GPUBindGroupLayout,
  extraEntries?: GPUBindGroupEntry[],
): ShadowCaster[];

/** Sync caster world matrices that have changed since last frame. */
export function syncCasterMatrices(device: GPUDevice, casters: ShadowCaster[]): void;

/** Write shadow generator state into a Float32Array(24) for UBO upload.
 *  Layout: [lightMatrix(16), depthValues.x, depthValues.y, 0, 0, shadowsInfo(4)] */
export function writeShadowUboFields(
  out: Float32Array,
  sg: { lightMatrix: Float32Array; depthValues: Float32Array; shadowsInfo: Float32Array },
): void;

/** Compare two Float32Array(16) matrices. Returns true if any element differs. */
export function shadowMatrixChanged(a: Float32Array, b: Float32Array): boolean;

/** Draw all casters into the current render pass. */
export function drawCasters(pass: GPURenderPassEncoder, casters: ShadowCaster[]): void;
```

### Common ShadowGenerator Interface (`shadow-generator.ts`)

```typescript
export interface ShadowGeneratorConfig {
  mapSize?: number;           // Default: 1024
  depthScale?: number;        // Default: 50
  bias?: number;              // Default: 0.00005
  blurScale?: number;         // Default: 2
  darkness?: number;          // Default: 0
  frustumEdgeFalloff?: number;// Default: 0
  orthoMinZ?: number;         // Default: 1  — ortho projection near Z
  orthoMaxZ?: number;         // Default: 10000 — ortho projection far Z
}

export type ShadowCasterMesh = ShadowCaster;   // Re-export from shadow-base

export interface ShadowGenerator {
  /** Shadow technique: 'esm' (exponential) or 'pcf' (percentage closer filtering). */
  shadowType: 'esm' | 'pcf';
  /** The light that owns this shadow generator. */
  light: LightBase;
  blurredTexture: GPUTexture;            // ESM: blurred output (rgba16float); PCF: depth texture (depth32float)
  blurredSampler: GPUSampler;            // ESM: linear clamp; PCF: comparison sampler
  renderShadowMap: (encoder: GPUCommandEncoder) => number;  // Returns draw count
  lightMatrix: Float32Array;             // 16-element light view-projection
  shadowsInfo: Float32Array;             // ESM: [darkness, 0, depthScale, frustumEdgeFalloff]
                                         // PCF: [darkness, mapSize, 1/mapSize, 0]
  depthValues: Float32Array;             // [0, 1] for WebGPU
  depthMeshBGL: GPUBindGroupLayout;      // Bind group layout for per-mesh shadow depth
  shadowParamsUBO: GPUBuffer;            // Shared shadow parameters UBO
  config: Required<ShadowGeneratorConfig>;
  /** Monotonically increasing version — bumped each time lightMatrix changes.
   *  Consumers compare against a stashed version to skip redundant UBO uploads. */
  _version: number;
}
```

### ESM Factory Function (`shadow-generator.ts`)

```typescript
export function createShadowGenerator(
  engine: Engine,
  light: DirectionalLight,
  casterMeshes: Mesh[],
  cfg?: ShadowGeneratorConfig,
): ShadowGenerator;
```

### PCF Factory Function (`pcf-shadow-generator.ts`)

```typescript
export interface PcfShadowGeneratorConfig {
  mapSize?: number;      // Default: 512
  bias?: number;         // Default: 0.00005
  darkness?: number;     // Default: 0
  normalBias?: number;   // Default: 0
  near?: number;         // Default: 1 (camera near)
  far?: number;          // Default: light.range or 10000
}

export function createPcfShadowGenerator(
  engine: Engine,
  light: SpotLight,
  casterMeshes: Mesh[],
  cfg?: PcfShadowGeneratorConfig,
): ShadowGenerator;
```

### Imports (ESM generator)

```typescript
import type { DirectionalLight } from '../light/directional-light.js';
import type { Mesh } from '../mesh/mesh.js';
import type { Engine, EngineInternal } from '../engine/engine.js';
import { getOrCreateSampler } from '../resource/gpu-pool.js';
import { buildCasters, syncCasterMatrices, drawCasters, shadowMatrixChanged } from './shadow-base.js';
import depthVertSrc  from '../../shaders/shadow-depth.vertex.wgsl?raw';
import depthFragSrc  from '../../shaders/shadow-depth.fragment.wgsl?raw';
import blurVertSrc   from '../../shaders/shadow-blur.vertex.wgsl?raw';
import blurFragSrc   from '../../shaders/shadow-blur.fragment.wgsl?raw';
// Shadow depth shaders inline a minimal light-view SceneUniforms declaration.
```

### Imports (PCF generator)

```typescript
import type { SpotLight } from '../light/spot-light.js';
import type { Mesh } from '../mesh/mesh.js';
import type { Engine, EngineInternal } from '../engine/engine.js';
import type { ShadowGenerator } from './shadow-generator.js';
import { buildCasters, syncCasterMatrices, drawCasters, shadowMatrixChanged } from './shadow-base.js';
import depthVertSrc from '../../shaders/shadow-pcf-depth.vertex.wgsl?raw';
import { registerPcfShadowShader, registerPcfShadowBgl } from '../material/standard/standard-pipeline.js';
// Shadow depth shaders inline a minimal light-view SceneUniforms declaration.
```

---

## Internal Architecture

### Shadow Base Shared Infrastructure (`shadow-base.ts`)

All shadow generators share a common caster management layer:

- **`buildCasters()`** — iterates `Mesh[]`, reads each mesh's internal GPU state (`_gpu.positionBuffer`, `_gpu.indexBuffer`, `_gpu.indexCount`), creates a 64-byte world-matrix UBO per caster, and builds per-caster bind groups. Accepts optional `extraEntries` for technique-specific bindings (ESM adds the shadow params UBO at binding 1; PCF does not).
- **`syncCasterMatrices()`** — per-frame check: compares `mesh.worldMatrixVersion` against a stashed `_lastWorldVersion` and re-uploads only dirty world matrices.
- **`drawCasters()`** — issues indexed draw calls: for each caster, sets vertex buffer 0, index buffer (uint32), bind group 1, and calls `drawIndexed`.
- **`writeShadowUboFields()`** — packs a `ShadowGenerator`'s light matrix (16 floats), depth values (2 floats + 2 padding), and shadowsInfo (4 floats) into a 24-float array for downstream UBO upload.
- **`shadowMatrixChanged()`** — element-wise Float32Array(16) comparison; returns `true` if any element differs.

### ESM Generator — GPU Textures

| Label            | Size               | Format        | Usage                                    |
|------------------|--------------------|---------------|------------------------------------------|
| `shadow-esm`    | mapSize × mapSize  | `rgba16float` | RENDER_ATTACHMENT \| TEXTURE_BINDING     |
| `shadow-depth-buf` | mapSize × mapSize | `depth32float`| RENDER_ATTACHMENT                        |
| `shadow-blur-h` | blurSize × blurSize| `rgba16float` | RENDER_ATTACHMENT \| TEXTURE_BINDING     |
| `shadow-blur-v` | blurSize × blurSize| `rgba16float` | RENDER_ATTACHMENT \| TEXTURE_BINDING     |

Where `blurSize = mapSize / blurScale` (default: 1024 / 2 = 512).

### PCF Generator — GPU Textures

| Label              | Size              | Format        | Usage                                    |
|--------------------|-------------------|---------------|------------------------------------------|
| `shadow-pcf-depth` | mapSize × mapSize | `depth32float`| RENDER_ATTACHMENT \| TEXTURE_BINDING     |

No color attachments, no blur textures. The depth texture is directly sampled in the main pass with a comparison sampler.

### Uniform Buffers (ESM)

#### Scene UBO (depthSceneUBO) — 64 bytes
| Offset | Size | Content                  |
|--------|------|--------------------------|
| 0      | 64B  | Light view-projection matrix (mat4x4<f32>) |

#### Shadow Params UBO (shadowParamsUBO) — 32 bytes
| Offset (bytes) | Float32 Index | Content                                      |
|-----------------|---------------|----------------------------------------------|
| 0               | [0]           | bias (default: 0.00005)                      |
| 4               | [1]           | *(unused)*                                   |
| 8               | [2]           | depthScale (default: 50)                     |
| 12              | [3]           | *(unused)*                                   |
| 16              | [4]           | depthMinZ = 0 (WebGPU directional light)     |
| 20              | [5]           | depthMinZ + depthMaxZ = 1                    |
| 24              | [6]           | *(unused)*                                   |
| 28              | [7]           | *(unused)*                                   |

#### Per-Caster Mesh UBO — 64 bytes
| Offset | Size | Content                       |
|--------|------|-------------------------------|
| 0      | 64B  | World matrix (mat4x4<f32>)    |

#### Blur H UBO — 16 bytes
| Offset | Content                                 |
|--------|-----------------------------------------|
| 0–7    | `delta = (1.0 / blurSize, 0)` as vec2   |
| 8–15   | padding (0, 0)                          |

#### Blur V UBO — 16 bytes
| Offset | Content                                 |
|--------|-----------------------------------------|
| 0–7    | `delta = (0, 1.0 / blurSize)` as vec2   |
| 8–15   | padding (0, 0)                          |

### Uniform Buffers (PCF)

#### Scene UBO (depthSceneUBO) — 64 bytes
Same as ESM: light view-projection matrix.

#### Shadow Params UBO — 32 bytes
| Offset (bytes) | Float32 Index | Content                                      |
|-----------------|---------------|----------------------------------------------|
| 0               | [0]           | bias (default: 0.00005)                      |
| 4               | [1]           | *(unused)*                                   |
| 8               | [2]           | 1 / mapSize (texel size, reuses depthScale slot) |
| 12              | [3]           | *(unused)*                                   |
| 16              | [4]           | depthMinZ = 0                                |
| 20              | [5]           | depthMinZ + depthMaxZ = 1                    |
| 24              | [6]           | *(unused)*                                   |
| 28              | [7]           | *(unused)*                                   |

#### Per-Caster Mesh UBO — 64 bytes
Same as ESM: world matrix only. PCF does not bind the shadow params UBO to per-caster groups.

### shadowsInfo Layout Differences

| Field Index | ESM                     | PCF                |
|-------------|-------------------------|--------------------|
| [0]         | darkness                | darkness           |
| [1]         | 0 (unused)              | mapSize            |
| [2]         | depthScale              | 1 / mapSize        |
| [3]         | frustumEdgeFalloff      | 0 (unused)         |

### Light View-Projection Matrix Computation

#### ESM: `computeDirectionalLightMatrix` (orthographic)

```typescript
function computeDirectionalLightMatrix(
  light: DirectionalLight,
  casterMeshes: Mesh[],
  orthoMinZ: number,
  orthoMaxZ: number,
): { viewProj: Float32Array; near: number; far: number }
```

**Algorithm:**
1. Normalize light direction vector: `dir = normalize(light.direction)`
2. Choose up vector: `(0, 1, 0)` unless `|dirY| > 0.99`, then `(0, 0, 1)`
3. Build orthonormal basis:
   - `right = normalize(cross(up, dir))`
   - `up' = cross(dir, right)`
4. Build view matrix (column-major, forward = dir):
   ```
   V = | rx  ux  dirX  0 |
       | ry  uy  dirY  0 |
       | rz  uz  dirZ  0 |
       | -dot(r,P) -dot(u,P) -dot(dir,P) 1 |
   ```
   Where `P = light.position`
5. Transform all 8 corners of each caster's local AABB (`mesh.boundMin`/`boundMax`, default unit cube) through `worldMatrix` then through `view` → compute X/Y bounds in light space
6. Expand bounds by 10% (`shadowOrthoScale = 0.1`): `lMinX -= (lMaxX - lMinX) * 0.1` etc.
7. Z bounds from `orthoMinZ`/`orthoMaxZ` (camera near/far)
8. Build orthographic projection (column-major, WebGPU z=[0,1]):
   ```
   P[0]  = 2 / (lMaxX - lMinX)
   P[5]  = 2 / (lMaxY - lMinY)
   P[10] = 1 / (far - near)
   P[12] = -(lMaxX + lMinX) / (lMaxX - lMinX)
   P[13] = -(lMaxY + lMinY) / (lMaxY - lMinY)
   P[14] = -near / (far - near)
   P[15] = 1
   ```
9. Multiply: `viewProj = proj * view` (standard 4×4 multiply)

#### PCF: `computeSpotLightMatrix` (perspective)

```typescript
function computeSpotLightMatrix(
  light: SpotLight,
  near: number,
  far: number,
): { viewProj: Float32Array; near: number; far: number }
```

**Algorithm:**
1. Normalize light direction: `dir = normalize(light.direction)`
2. Choose up vector: `(0, 1, 0)` unless `|dirY| > 0.99`, then `(0, 0, 1)`
3. Build orthonormal basis (same as ESM): `right = cross(up, dir)`, `up' = cross(dir, right)`
4. Build view matrix (column-major) from `light.position`
5. Build **perspective** projection (column-major, WebGPU z=[0,1]):
   - FOV = `light.angle` (full cone angle in radians)
   - Aspect = 1:1 (square shadow map)
   ```
   f = 1 / tan(FOV * 0.5)
   P[0]  = f          // aspect = 1
   P[5]  = f
   P[10] = far / (far - near)
   P[11] = 1          // perspective divide
   P[14] = -(far * near) / (far - near)
   ```
6. Multiply: `viewProj = proj * view`

---

## Pipeline Configuration

### ESM Shadow Depth Pipeline

**Vertex buffers:**

| Slot | Stride | Attribute | Location | Format      |
|------|--------|-----------|----------|-------------|
| 0    | 12B    | position  | 0        | float32x3   |

**Bind group layouts:**

Group 0 — `shadow-depth-scene`:
| Binding | Visibility | Type    | Content                         |
|---------|------------|---------|---------------------------------|
| 0       | VERTEX     | uniform | Light view-projection (64 bytes)|

Group 1 — `shadow-depth-mesh`:
| Binding | Visibility       | Type    | Content                         |
|---------|------------------|---------|---------------------------------|
| 0       | VERTEX           | uniform | World matrix (64 bytes)         |
| 1       | VERTEX+FRAGMENT  | uniform | Shadow params (32 bytes)        |

**Pipeline state:**
- Primitive: `triangle-list`, cull: `back`, front: `ccw`
- Depth/stencil: `depth32float`, write: `true`, compare: `less-equal`
- Color target: `rgba16float` (1 target)
- No multisample

### ESM Blur Pipeline

**Vertex buffers:** None (fullscreen triangle from vertex_index)

**Bind group layout** — `shadow-blur`:
| Binding | Visibility       | Type      | Content                   |
|---------|------------------|-----------|---------------------------|
| 0       | VERTEX+FRAGMENT  | uniform   | BlurParams (16 bytes)     |
| 1       | FRAGMENT         | texture   | Source texture (float)     |
| 2       | FRAGMENT         | sampler   | Linear filtering sampler  |

**Pipeline state:**
- Primitive: `triangle-list`, cull: `none`
- No depth/stencil
- Color target: `rgba16float` (1 target)

**Blur sampler:**
- `minFilter: 'linear'`, `magFilter: 'linear'`
- `addressModeU: 'clamp-to-edge'`, `addressModeV: 'clamp-to-edge'`

**Output sampler (returned as `blurredSampler`):**
- Same configuration as blur sampler

### PCF Shadow Depth Pipeline

**Vertex buffers:**

| Slot | Stride | Attribute | Location | Format      |
|------|--------|-----------|----------|-------------|
| 0    | 12B    | position  | 0        | float32x3   |

**Bind group layouts:**

Group 0 — `pcf-depth-scene`:
| Binding | Visibility | Type    | Content                         |
|---------|------------|---------|---------------------------------|
| 0       | VERTEX     | uniform | Light view-projection + `pcfBias` (80 bytes) |

Group 1 — `pcf-depth-mesh`:
| Binding | Visibility | Type    | Content                         |
|---------|------------|---------|---------------------------------|
| 0       | VERTEX     | uniform | World matrix (64 bytes)         |

**Pipeline state:**
- Primitive: `triangle-list`, cull: `back`, front: `ccw`
- Depth/stencil: `depth32float`, write: `true`, compare: `less-equal`
- Bias handling: PCF uses Babylon-style clip-space linear bias in the depth vertex shader (`clipPos.z += scene.pcfBias.x * clipPos.w`). The shadow-pass scene UBO stores `bias * 0.5` for WebGPU half-Z depth. PCF does **not** use WebGPU pipeline `depthBias` / `depthBiasSlopeScale`.
- **No color targets** (depth-only pass)
- **No fragment shader** (vertex-only pipeline)
- No multisample

### PCF Main-Pass Integration

The PCF generator dynamically registers shader snippets and bind group layout via `registerPcfShadowShader()` and `registerPcfShadowBgl()` into the standard material pipeline. This is lazy/one-shot — guarded by `_pcfRegistered` flag.

**Registered bind group (group 2) for main pass:**
| Binding | Type               | Content                          |
|---------|--------------------|----------------------------------|
| 0       | `texture_depth_2d` | Shadow depth texture             |
| 1       | `sampler_comparison`| Comparison sampler (compare: `less`, linear filtering) |

**Registered shader fragments (injected into standard fragment shader):**

- **Declarations:** `@group(2) @binding(0) var shadowTex: texture_depth_2d; @group(2) @binding(1) var shadowCompSampler: sampler_comparison;`
- **Function:** `computeShadowWithPCF(posFromLight, depthMetric, darkness, mapSize, invMapSize) → f32`
- **Call site:** `shadow = computeShadowWithPCF(input.vPositionFromLight, input.vDepthMetric, shadowInfo.shadowsInfo.x, shadowInfo.shadowsInfo.y, shadowInfo.shadowsInfo.z);`

---

## Shader Logic

### Shadow Depth Vertex Shader — ESM (`shadow-depth.vertex.wgsl`)

```wgsl
struct SceneUniforms { viewProjection: mat4x4<f32> };            // @group(0) @binding(0)
struct MeshUniforms  { world: mat4x4<f32> };                     // @group(1) @binding(0)
struct ShadowParams  {
  biasAndScale: vec4<f32>,  // x=bias, y=unused, z=depthScale, w=unused
  depthValues: vec4<f32>,   // x=near(0), y=far(1)
};                                                                // @group(1) @binding(1)

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) vDepthMetricSM: f32,
};

@vertex fn main(@location(0) position: vec3<f32>) -> VertexOutput {
  worldPos = mesh.world * vec4(position, 1.0)
  clipPos  = scene.viewProjection * worldPos
  vDepthMetricSM = (clipPos.z + depthValues.x) / depthValues.y + bias
}
```

**Depth metric formula:**
```
vDepthMetricSM = (clipPos.z + 0) / 1 + 0.00005
               = clipPos.z + bias
```
(For WebGPU directional light: `depthValues = (0, 1)`)

### Shadow Depth Fragment Shader — ESM (`shadow-depth.fragment.wgsl`)

```wgsl
@fragment fn main(@location(0) vDepthMetricSM: f32) -> @location(0) vec4<f32> {
  depthSM = clamp(exp(-min(87.0, depthScale * vDepthMetricSM)), 0.0, 1.0)
  return vec4(depthSM, 1.0, 1.0, 1.0)
}
```

**ESM encoding formula:**
```
output.r = clamp(exp(-min(87.0, 50.0 * depth)), 0, 1)
```
The `min(87.0, ...)` prevents float overflow in `exp()`. The result is stored in the red channel. Closer fragments (depth ≈ 0) produce values near 1.0; farther fragments produce values near 0.0.

### Shadow Depth Vertex Shader — PCF (`shadow-pcf-depth.vertex.wgsl`)

```wgsl
struct SceneUniforms {
  viewProjection: mat4x4<f32>,
  pcfBias: vec4<f32>,
};                                                     // @group(0) @binding(0)
struct MeshUniforms  { world: mat4x4<f32> };           // @group(1) @binding(0)

@vertex fn main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  clipPos = scene.viewProjection * mesh.world * vec4(position, 1.0);
  clipPos.z += scene.pcfBias.x * clipPos.w;
  return clipPos;
}
```

No fragment shader — depth-only pass. Hardware writes `builtin(position).z` to the depth buffer. Bias is applied in clip space through `scene.pcfBias`; PCF does not use WebGPU pipeline depth-bias state.

### PCF Sampling Function (injected into main pass fragment shader)

```wgsl
fn computeShadowWithPCF(
  posFromLight: vec4<f32>,
  depthMetric: f32,
  darkness: f32,
  mapSize: f32,
  invMapSize: f32,
) -> f32 {
  // Project to shadow UV
  let clipSpace = posFromLight.xyz / posFromLight.w;
  let uv = vec2(0.5 * clipSpace.x + 0.5, 0.5 - 0.5 * clipSpace.y);
  if (uv out of [0,1]) { return 1.0; }  // outside shadow map → fully lit

  let depthRef = clamp(clipSpace.z, 0.0, 1.0);

  // 5×5 optimised bilinear PCF (9 taps via 3×3 grid with fractional offsets)
  var tc = uv * mapSize + 0.5;
  let st = fract(tc);
  let base = (floor(tc) - 0.5) * invMapSize;

  // Bilinear weights from sub-texel position
  let uvw0 = 4.0 - 3.0 * st;
  let uvw1 = vec2(7.0);
  let uvw2 = 1.0 + 3.0 * st;

  // Optimised sample offsets (3 per axis)
  let u = vec3((3.0 - 2.0*st.x)/uvw0.x - 2.0, (3.0+st.x)/uvw1.x, st.x/uvw2.x + 2.0) * invMapSize;
  let v = vec3((3.0 - 2.0*st.y)/uvw0.y - 2.0, (3.0+st.y)/uvw1.y, st.y/uvw2.y + 2.0) * invMapSize;

  // 9 comparison samples (3×3 grid), weight sum = 144
  var sh = 0.0;
  for each (ui, vi) in 3×3 grid:
    sh += uvw_u * uvw_v * textureSampleCompareLevel(shadowTex, shadowCompSampler, base + vec2(u[ui], v[vi]), depthRef);
  sh /= 144.0;

  return mix(darkness, 1.0, sh);
}
```

### Shadow Blur Vertex Shader (`shadow-blur.vertex.wgsl`)

```wgsl
struct BlurParams {
  delta: vec2<f32>,   // texel step direction
  _pad: vec2<f32>,
};                    // @group(0) @binding(0)

@vertex fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Fullscreen triangle (oversized, clipped by rasterizer)
  positions = [(-1, -1), (3, -1), (-1, 3)]
  clipPos = vec4(positions[vertexIndex], 0, 1)
  sampleCenter = p * vec2(0.5, -0.5) + 0.5   // clip → UV
}
```

### Shadow Blur Fragment Shader (`shadow-blur.fragment.wgsl`)

Implements a 33-tap Gaussian blur matching Babylon's `kernelBlur` post-process with `blurKernel = 64`.

**Tap structure:** 26 bilinear taps + 7 dependent taps = 33 total.

**Bilinear tap offsets (26 values, symmetric pairs):**
```
±31.43122487, ±29.43554136, ±27.43986765, ±25.44420309,
±23.44854704, ±21.45289886, ±19.45725789, ±17.46162348,
±15.46599496, ±13.47037167, ±11.47475294, ±9.4791381,
±7.48352647
```

**Bilinear tap weights (26 values, symmetric pairs):**
```
0.00096573, 0.00096573, 0.00164886, 0.00164886,
0.0027182,  0.0027182,  0.00432655, 0.00432655,
0.00664916, 0.00664916, 0.00986638, 0.00986638,
0.01413558, 0.01413558, 0.01955395, 0.01955395,
0.02611683, 0.02611683, 0.03367998, 0.03367998,
0.04193613, 0.04193613, 0.05041622, 0.05041622,
0.05852177, 0.05852177
```

**Dependent tap offsets (7 values, symmetric pairs + center):**
```
-5.48791739, 5.48791739, -3.49231018, 3.49231018,
-1.49670415, 1.49670415, 0.0
```

**Dependent tap weights (7 values):**
```
0.06558884, 0.06558884, 0.0709754, 0.0709754,
0.07415683, 0.07415683, 0.0374872
```

**Fragment algorithm:**
```wgsl
@fragment fn main(@location(0) sampleCenter: vec2<f32>) -> @location(0) vec4<f32> {
  var blend = vec4(0.0);

  // 26 bilinear taps
  for (i in 0..26) {
    coord = sampleCenter + params.delta * OFFSETS[i]
    blend += textureSample(srcTex, srcSampler, coord) * WEIGHTS[i]
  }

  // 7 dependent taps
  for (i in 0..7) {
    coord = sampleCenter + params.delta * DEP_OFFSETS[i]
    blend += textureSample(srcTex, srcSampler, coord) * DEP_WEIGHTS[i]
  }

  return blend;
}
```

---

## State Machine / Lifecycle

### ESM Initialization (once)

1. Compute light view-projection matrix from `DirectionalLight` + caster mesh world AABBs
2. Create `depthMeshBGL` with 2 bindings (world matrix + shadow params)
3. Create shadow params UBO (bias, depthScale, depthValues)
4. Build casters via `buildCasters()` with shadow params as extra bind group entry
5. Create 4 GPU textures: ESM target, depth buffer, blur-H target, blur-V target
6. Create depth scene UBO and write light viewProj matrix
7. Create depth pipeline (vertex + fragment) with 2 bind group layouts
8. Create blur pipeline (vertex + fragment) with 1 bind group layout
9. Create blur UBOs for H/V passes with appropriate delta vectors
10. Create all bind groups
11. Return `ShadowGenerator` with `shadowType: 'esm'`

### PCF Initialization (once)

1. Call `ensurePcfRegistered()` — one-shot registration of PCF shader snippets and bind group layout into the standard material pipeline
2. Compute spot light perspective view-projection matrix
3. Create `depthMeshBGL` with 1 binding (world matrix only — no shadow params)
4. Build casters via `buildCasters()` (no extra entries)
5. Create single depth-only texture (`depth32float`, RENDER_ATTACHMENT + TEXTURE_BINDING)
6. Create depth scene UBO and write light viewProj matrix
7. Create depth-only pipeline (vertex shader only, no fragment shader, no color targets)
8. Create comparison sampler (`compare: 'less'`, linear filtering)
9. Create shadow params UBO (bias, texel size, depthValues)
10. Return `ShadowGenerator` with `shadowType: 'pcf'`

### Per-Frame Rendering — ESM (`renderShadowMap(encoder)`)

```
Recompute light matrix → compare with shadowMatrixChanged() → update if dirty
syncCasterMatrices()

Pass 1: Shadow Depth
  ├─ Clear esmTexture to (0,0,0,0), depthBuf to 1.0
  ├─ Set depthPipeline
  ├─ Set group(0) = depthSceneBG (light viewProj)
  └─ For each caster (via drawCasters):
       ├─ Set vertex buffer 0 = positionBuffer
       ├─ Set index buffer (uint32)
       ├─ Set group(1) = casterBindGroup
       └─ drawIndexed(indexCount)

Pass 2: Blur Horizontal
  ├─ Clear blurTexH to (0,0,0,0)
  ├─ Set blurPipeline
  ├─ Set group(0) = blurHBG (delta=(1/blurSize, 0), source=esmTexture)
  └─ draw(3)  // fullscreen triangle

Pass 3: Blur Vertical
  ├─ Clear blurTexV to (0,0,0,0)
  ├─ Set blurPipeline
  ├─ Set group(0) = blurVBG (delta=(0, 1/blurSize), source=blurTexH)
  └─ draw(3)  // fullscreen triangle

Returns: casters.length + 2  (depth draws + 2 blur passes)
```

### Per-Frame Rendering — PCF (`renderShadowMap(encoder)`)

```
Recompute spot light matrix → compare with shadowMatrixChanged() → update if dirty
syncCasterMatrices()

Pass 1: Shadow Depth (single pass, depth-only)
  ├─ colorAttachments: []  (no color output)
  ├─ Clear depthTexture to 1.0
  ├─ Set depthPipeline
  ├─ Set group(0) = depthSceneBG (light viewProj)
  └─ For each caster (via drawCasters):
       ├─ Set vertex buffer 0 = positionBuffer
       ├─ Set index buffer (uint32)
       ├─ Set group(1) = casterBindGroup
       └─ drawIndexed(indexCount)

Returns: casters.length  (depth draws only — no blur passes)
```

---

## Shadow Renderable (`shadow-renderable.ts`)

Currently a placeholder module:
```typescript
/** Shadow pre-pass renderable — placeholder for future shadow pass integration. */
```

Reserved for future integration of shadow maps into the general render pipeline's renderable system. Not yet implemented.

---

## Babylon.js Equivalence Map

| Babylon Lite                                        | Babylon.js                                                            |
|-----------------------------------------------------|-----------------------------------------------------------------------|
| `createShadowGenerator()`                          | `new ShadowGenerator(mapSize, light)` with ESM config                |
| `createPcfShadowGenerator()`                       | `new ShadowGenerator(mapSize, light)` with PCF config                |
| `ShadowGenerator.shadowType === 'esm'`             | `ShadowGenerator.useBlurExponentialShadowMap = true`                 |
| `ShadowGenerator.shadowType === 'pcf'`             | `ShadowGenerator.usePercentageCloserFiltering = true`                |
| `ShadowGeneratorConfig.mapSize`                    | `ShadowGenerator.mapSize`                                            |
| `ShadowGeneratorConfig.depthScale`                 | `ShadowGenerator.depthScale`                                         |
| `ShadowGeneratorConfig.bias`                       | `ShadowGenerator.bias`                                               |
| `ShadowGeneratorConfig.blurScale`                  | `ShadowGenerator.blurScale`                                          |
| `ShadowGeneratorConfig.darkness`                   | `ShadowGenerator.darkness`                                           |
| `ShadowGeneratorConfig.frustumEdgeFalloff`         | `ShadowGenerator.frustumEdgeFalloff`                                 |
| `PcfShadowGeneratorConfig.normalBias`              | `ShadowGenerator.normalBias`                                         |
| ESM encoding (`exp(-depthScale*d)`)                | `ShadowGenerator.useBlurExponentialShadowMap = true`                 |
| 33-tap Gaussian blur (kernel=64)                   | `ShadowGenerator.useKernelBlur = true; .blurKernel = 64`            |
| PCF 5×5 bilinear (9 optimised taps)               | `ShadowGenerator.filteringQuality = SM_PCF`                         |
| `computeDirectionalLightMatrix()`                  | `DirectionalLight._setDefaultAutoExtendShadowProjectionMatrix()`     |
| `computeSpotLightMatrix()`                         | `SpotLight._setDefaultShadowProjectionMatrix()`                      |
| `shadowOrthoScale = 0.1` (expand)                  | `DirectionalLight.shadowOrthoScale = 0.1`                           |
| `depthValues = [0, 1]`                             | `DirectionalLight.getDepthMinZ()=0`, `getDepthMaxZ()=1` (WebGPU)    |
| `buildCasters()`                                    | `ShadowGenerator.addShadowCaster(mesh)` (internal)                  |
| `syncCasterMatrices()`                              | `ShadowGenerator._renderForShadowMap()` world matrix sync (internal)|
| `drawCasters()`                                     | `ShadowGenerator._renderSubMeshForShadowMap()` (internal)           |
| `renderShadowMap(encoder)`                         | `ShadowGenerator._renderForShadowMap()` (internal)                  |
| `blurredTexture`                                    | `ShadowGenerator.getShadowMap()` (after blur passes)                |
| `lightMatrix`                                       | `ShadowGenerator.getTransformMatrix()`                              |
| `writeShadowUboFields()`                           | Internal UBO packing in Babylon's shadow system                      |
| `ShadowGenerator._version`                         | No direct equivalent — Lite uses version for dirty tracking          |

---

## Dependencies

### shadow-base.ts
- `../mesh/mesh.js` — `Mesh`, `MeshInternal` interfaces

### shadow-generator.ts (ESM)
- `../light/directional-light.js` — `DirectionalLight` interface
- `../mesh/mesh.js` — `Mesh` interface
- `../engine/engine.js` — `Engine`, `EngineInternal`
- `../resource/gpu-pool.js` — `getOrCreateSampler`
- Inline `SHADOW_LIGHT_VIEW_WGSL` — minimal `SceneUniforms { viewProjection }` for light-space depth rendering
- `./shadow-base.js` — `buildCasters`, `syncCasterMatrices`, `drawCasters`, `shadowMatrixChanged`
- `../../shaders/shadow-depth.vertex.wgsl` — depth vertex shader (raw import)
- `../../shaders/shadow-depth.fragment.wgsl` — depth fragment shader (raw import)
- `../../shaders/shadow-blur.vertex.wgsl` — blur vertex shader (raw import)
- `../../shaders/shadow-blur.fragment.wgsl` — blur fragment shader (raw import)

### pcf-shadow-generator.ts (PCF)
- `../light/spot-light.js` — `SpotLight` interface
- `../mesh/mesh.js` — `Mesh` interface
- `../engine/engine.js` — `Engine`, `EngineInternal`
- `../material/standard/standard-flags.js` — `registerPcfShadowShader`, `registerPcfShadowBgl`
- Inline `SHADOW_LIGHT_VIEW_WGSL` — minimal `SceneUniforms { viewProjection, pcfBias }` for light-space depth rendering
- `./shadow-base.js` — `buildCasters`, `syncCasterMatrices`, `drawCasters`, `shadowMatrixChanged`
- `./shadow-generator.js` — `ShadowGenerator` type
- `../../shaders/shadow-pcf-depth.vertex.wgsl` — PCF depth vertex shader (raw import)

### shadow-renderable.ts
- None (placeholder)

---

## Test Specification

1. **ESM light matrix computation** — Given a directional light at direction `(-1, -3, 2)` with caster meshes, verify the computed view-projection matrix produces correct NDC coordinates for known world points.
2. **ESM encoding** — For depth value 0.5 and depthScale 50: `exp(-min(87, 50 * 0.5)) = exp(-25) ≈ 1.389e-11 ≈ 0` (clamped). For depth 0.01: `exp(-0.5) ≈ 0.6065`.
3. **Blur weight normalization** — Sum of all 33 weights (26 bilinear + 7 dependent) should equal ≈ 1.0.
4. **ESM render pass count** — `renderShadowMap` should encode exactly 3 render passes; return value = `casters.length + 2`.
5. **PCF render pass count** — `renderShadowMap` should encode exactly 1 render pass (depth-only); return value = `casters.length`.
6. **Texture dimensions** — ESM with `mapSize=1024, blurScale=2`: ESM is 1024², blur textures are 512². PCF with `mapSize=512`: depth texture is 512².
7. **UBO sizes** — Scene: 64B, shadow params: 32B, mesh: 64B, blur: 16B.
8. **ESM default config** — Verify: `mapSize=1024, depthScale=50, bias=0.00005, blurScale=2, darkness=0, frustumEdgeFalloff=0, orthoMinZ=1, orthoMaxZ=10000`.
9. **PCF default config** — Verify: `mapSize=512, bias=0.00005, darkness=0, normalBias=0, near=1, far=10000 or light.range`.
10. **PCF spot light matrix** — Verify perspective projection uses `light.angle` as FOV, 1:1 aspect, correct near/far.
11. **PCF shadowsInfo packing** — `[darkness, mapSize, 1/mapSize, 0]`.
12. **Caster sync** — After mutating a mesh's worldMatrixVersion, `syncCasterMatrices` re-uploads only dirty casters.
13. **shadowMatrixChanged** — Returns false for identical arrays, true for any single differing element.
14. **writeShadowUboFields** — Output Float32Array(24) matches expected layout: [lightMatrix×16, depthValues.x, depthValues.y, 0, 0, shadowsInfo×4].
15. **PCF registration guard** — `ensurePcfRegistered()` only calls `registerPcfShadowShader` and `registerPcfShadowBgl` once.

---

## File Manifest

| File | Role |
|------|------|
| `src/shadow/shadow-base.ts` | Shared caster infrastructure: `ShadowCaster` type, `buildCasters()`, `syncCasterMatrices()`, `drawCasters()`, `writeShadowUboFields()`, `shadowMatrixChanged()` |
| `src/shadow/shadow-generator.ts` | ESM shadow generator — factory function, directional light matrix (orthographic), 3-pass pipeline (depth + 2× blur) |
| `src/shadow/pcf-shadow-generator.ts` | PCF shadow generator — factory function, spot light matrix (perspective), 1-pass depth-only pipeline, inlined PCF shader snippets |
| `src/shadow/shadow-renderable.ts` | Placeholder for future shadow pass renderable integration |
| `shaders/shadow-depth.vertex.wgsl` | ESM vertex shader: transforms caster vertices to light clip space, outputs ESM depth metric |
| `shaders/shadow-depth.fragment.wgsl` | ESM fragment shader: ESM encoding `exp(-depthScale * depth)` |
| `shaders/shadow-pcf-depth.vertex.wgsl` | PCF vertex shader: transforms caster vertices to light clip space (no fragment output) |
| `shaders/shadow-blur.vertex.wgsl` | Blur vertex shader: fullscreen triangle generation + UV computation |
| `shaders/shadow-blur.fragment.wgsl` | Blur fragment shader: 33-tap Gaussian blur (26 bilinear + 7 dependent taps) |
