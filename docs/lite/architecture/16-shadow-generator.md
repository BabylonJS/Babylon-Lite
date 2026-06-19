# Module: Shadow Generator
> Package path: `packages/babylon-lite/src/shadow/`

## Purpose

Implements two shadow mapping techniques for different light types:

1. **Exponential Shadow Mapping (ESM)** with two-pass Gaussian blur for **directional lights** — produces a blurred shadow texture that the main material pass samples. Pipeline per-frame: (1) render shadow casters from the light's perspective into an ESM depth texture, (2) horizontal Gaussian blur, (3) vertical Gaussian blur.

2. **Percentage Closer Filtering (PCF)** for **spot and directional lights** — renders casters into a depth-only texture; the main-pass fragment shader samples with a hardware comparison sampler (5×5 bilinear PCF). No blur passes needed — saves 2 draw calls and 2 GPU textures vs ESM.

Both generators return the same `ShadowGenerator` interface, so the downstream render pipeline is shadow-technique-agnostic. Caster meshes are registered as scene-owned `ShadowTask` inputs, not stored on `ShadowGenerator`. Shadow maps are scheduled by the scene's frame graph: shadow scenes opt into the internal `ShadowTask` by calling `registerSceneWithShadowSupport()`, so ordinary `registerScene()` bundles do not retain shadow scheduling code. PCF and ESM casters use per-source-material Standard/PBR/Node shadow material views, preserving material/mesh vertex features.

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
/** Write shadow generator state into a Float32Array(24) for UBO upload.
 *  Layout: [_lightMatrix(16), _depthValues.x, _depthValues.y, 0, 0, _shadowsInfo(4)] */
export function writeShadowUboFields(
  out: Float32Array,
  sg: { _lightMatrix: Float32Array; _depthValues: Float32Array; _shadowsInfo: Float32Array },
): void;

export function buildLightViewMatrix(dirX: number, dirY: number, dirZ: number, px: number, py: number, pz: number): Float32Array;
export function multiply4x4(a: Float32Array, b: Float32Array): Float32Array;
export function createShadowParamsUBO(engine: EngineContextInternal, bias: number, depthScale: number): GPUBuffer;
export function createSharedShadowUBO(engine: EngineContextInternal, _lightMatrix: Float32Array, _depthValues: Float32Array, _shadowsInfo: Float32Array): { ubo: GPUBuffer; data: Float32Array };
```

### ShadowTask Inputs (`frame-graph/shadow-inputs.ts`)

```typescript
export interface ShadowTaskInputs {
  readonly casterMeshes: readonly Mesh[];
}

export function setShadowTaskCasterMeshes(shadowGenerator: ShadowGenerator, casterMeshes: readonly Mesh[]): void;
```

Caster meshes are task inputs. Scene setup creates the filter-specific `ShadowGenerator`, assigns it to the light, calls `setShadowTaskCasterMeshes()` to provide the caster list, then calls `registerSceneWithShadowSupport()` instead of `registerScene()` to install the scene-owned shadow task.

### Common ShadowGenerator Interface (`shadow-generator.ts`)

```typescript
export interface ShadowGenerator {
  /** Shadow technique: 'esm' (exponential) or 'pcf' (percentage closer filtering). */
  _shadowType: 'esm' | 'pcf';
  /** The light that owns this shadow generator. */
  _light: LightBase;
  _depthTexture: GPUTexture;             // Receiver-facing map: ESM final blurred rgba16float, PCF depth32float
  _depthSampler: GPUSampler;             // Receiver-facing sampler: ESM linear sampler, PCF comparison sampler
  _lightMatrix: Float32Array;            // 16-element light view-projection
  _shadowsInfo: Float32Array;            // ESM: [darkness, 0, depthScale, frustumEdgeFalloff]
                                         // PCF: [darkness, mapSize, 1/mapSize, 0]
  _depthValues: Float32Array;            // Directional PCF/ESM: [0, 1]; spot PCF: [0, far]
  _shadowParamsUBO: GPUBuffer;           // Shared shadow parameters UBO
  _shadowUBO: GPUBuffer;                 // Receiver-side shadow info UBO
  _config: ShadowGeneratorRuntimeConfig; // minimal normalized fields read by shadow task hooks
  /** Monotonically increasing version — bumped each time _lightMatrix changes.
   *  Consumers compare against a stashed version to skip redundant UBO uploads. */
  _version: number;
}
```

### ESM Factory Function (`esm-directional-shadow-generator.ts`)

```typescript
export interface EsmDirectionalShadowGeneratorConfig {
  mapSize?: number;           // Default: 1024
  depthScale?: number;        // Default: 50
  bias?: number;              // Default: 0.00005
  blurScale?: number;         // Default: 2
  darkness?: number;          // Default: 0
  frustumEdgeFalloff?: number;// Default: 0
  orthoMinZ?: number;         // Default: 1  — ortho projection near Z
  orthoMaxZ?: number;         // Default: 10000 — ortho projection far Z
  forceRefreshEveryFrame?: boolean; // Default: false — regenerate every frame for GPU-driven/deforming casters
}

export function createEsmDirectionalShadowGenerator(
  engine: Engine,
  light: DirectionalLight,
  cfg?: EsmDirectionalShadowGeneratorConfig,
): ShadowGenerator;
```

### PCF Spot Factory Function (`pcf-spotlight-shadow-generator.ts`)

```typescript
export interface PcfSpotlightShadowGeneratorConfig {
  mapSize?: number;      // Default: 512
  bias?: number;         // Default: 0.00005
  darkness?: number;     // Default: 0
  normalBias?: number;   // Default: 0
  near?: number;         // Default: 1 (camera near)
  far?: number;          // Default: light.range or 10000
  forceRefreshEveryFrame?: boolean; // Default: false — regenerate every frame for GPU-driven/deforming casters
}

export function createPcfSpotlightShadowGenerator(
  engine: Engine,
  light: SpotLight,
  cfg?: PcfSpotlightShadowGeneratorConfig,
): ShadowGenerator;
```

### PCF Directional Factory Function (`pcf-directional-shadow-generator.ts`)

```typescript
export interface PcfDirectionalShadowGeneratorConfig {
  mapSize?: number;      // Default: 1024
  bias?: number;         // Default: 0.00005
  darkness?: number;     // Default: 0
  normalBias?: number;   // Default: 0
  orthoMinZ?: number;    // Default: 1
  orthoMaxZ?: number;    // Default: 10000
  forceRefreshEveryFrame?: boolean; // Default: false — regenerate every frame for GPU-driven/deforming casters
}

export function createPcfDirectionalShadowGenerator(
  engine: Engine,
  light: DirectionalLight,
  cfg?: PcfDirectionalShadowGeneratorConfig,
): ShadowGenerator;
```

### Imports (ESM generator)

```typescript
import type { DirectionalLight } from '../light/directional-light.js';
import type { Engine, EngineInternal } from '../engine/engine.js';
import { getOrCreateSampler } from '../resource/gpu-pool.js';
import { createSharedShadowUBO, createShadowParamsUBO } from './shadow-base.js';
import blurVertSrc   from '../../shaders/shadow-blur.vertex.wgsl?raw';
import blurFragSrc   from '../../shaders/shadow-blur.fragment.wgsl?raw';
```

### Imports (PCF generator)

```typescript
import type { SpotLight } from '../light/spot-light.js';
import type { Engine, EngineInternal } from '../engine/engine.js';
import type { ShadowGenerator } from './shadow-generator.js';
import { createSharedShadowUBO, createShadowParamsUBO } from './shadow-base.js';
import { ensurePcfShadowTaskState, preloadPcfShadowTaskState, renderPcfShadowMap } from './pcf-shadow-task-hooks.js';
```

---

## Internal Architecture

### Shadow Base Shared Infrastructure (`shadow-base.ts`)

Shadow generators share math and UBO packing helpers only. Caster ownership lives in `ShadowTaskInputs`:

- **`setShadowTaskCasterMeshes()`** — registers the caster mesh list for a generator in lazy task-owned input state.
- **`writeShadowUboFields()`** — packs a `ShadowGenerator`'s light matrix (16 floats), depth values (2 floats + 2 padding), and shadowsInfo (4 floats) into a 24-float array for downstream UBO upload.
- **`buildLightViewMatrix()` / `multiply4x4()`** — shared light-space matrix math for ESM and PCF task paths.
- **`createShadowParamsUBO()` / `createSharedShadowUBO()`** — shared GPU buffer setup for generator-owned receiver resources.

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

### shadowsInfo Layout Differences

| Field Index | ESM                     | PCF                |
|-------------|-------------------------|--------------------|
| [0]         | darkness                | darkness           |
| [1]         | 0 (unused)              | mapSize            |
| [2]         | depthScale              | 1 / mapSize        |
| [3]         | frustumEdgeFalloff      | 0 (unused)         |

### Light View-Projection Matrix Computation

#### Directional shadows: matrix computation (orthographic)

```typescript
function _computeDirectionalLightMatrix(
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

ESM owns its task-facing directional matrix helper as internal `_computeDirectionalLightMatrix()` in `shadow/esm-directional-shadow-generator.ts`. PCF owns the same orthographic helper as internal `_computeDirectionalLightMatrix()` in `shadow/pcf-directional-shadow-generator.ts` so directional shadow generator math remains with the relevant directional resource setup without becoming public API.

#### Spot PCF: `_computeSpotLightMatrix` (perspective)

```typescript
function _computeSpotLightMatrix(
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

The spot matrix helper is exported as internal `_computeSpotLightMatrix()` from `shadow/pcf-spotlight-shadow-generator.ts`.

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

The final vertical blur target is stored as `ShadowGenerator._depthTexture`; receivers bind `sg._depthTexture` and `sg._depthSampler` directly, the same as PCF.

### PCF Shadow Depth Pipeline

PCF depth rendering uses the regular material renderable path with a pass-specific no-color shadow material view. The active material family (Standard, PBR, or Node) supplies vertex buffers, mesh bind groups, and the pipeline; the view only changes render feature bits to select a variant whose fragment stage writes no color.

**Pipeline state:**
- Primitive/culling/vertex layout: inherited from the Standard/PBR material pipeline
- Depth/stencil: `depth32float`, write: `true`, compare: `less-equal`
- Bias handling: `ShadowTask` bakes Babylon-style clip-space linear bias (`bias * 0.5` for WebGPU half-Z depth) into the shadow pass view-projection matrix. PCF does **not** use WebGPU pipeline `depthBias` / `depthBiasSlopeScale`.
- **No color targets** (depth-only pass)
- **Fragment stage retained when needed** with a void entry point so material `discard` / alpha-test logic updates the depth attachment without writing color
- No multisample

### PCF Main-Pass Integration

Standard, PBR, and Node shadow receiver fragments emit PCF sampling code and bind-group layout directly from the scene's shadow-light list. There is no generator-side PCF shader registration path; the generator only exposes receiver-facing texture/sampler/UBO resources.

**Receiver bind group entries for main pass:**
| Binding | Type               | Content                          |
|---------|--------------------|----------------------------------|
| 0       | `texture_depth_2d` | Shadow depth texture             |
| 1       | `sampler_comparison`| Comparison sampler (compare: `less`, linear filtering) |

**Receiver shader fragments:**

- **Declarations:** `@group(2) @binding(0) var shadowTex: texture_depth_2d; @group(2) @binding(1) var shadowCompSampler: sampler_comparison;`
- **Function:** `computeShadowWithPCF(posFromLight, depthMetric, darkness, mapSize, invMapSize) → f32`
- **Call site:** `shadow = computeShadowWithPCF(input.vPositionFromLight, input.vDepthMetric, shadowInfo.shadowsInfo.x, shadowInfo.shadowsInfo.y, shadowInfo.shadowsInfo.z);`

---

## Shader Logic

### ESM Material Shadow View Vertex Path

```wgsl
struct SceneUniforms { viewProjection: mat4x4<f32> };            // @group(0) @binding(0)
struct MeshUniforms  { world: mat4x4<f32> };                     // @group(1) @binding(0)
struct ShadowParams  {
  biasAndScale: vec4<f32>,  // x=bias, y=unused, z=depthScale, w=unused
  depthValues: vec4<f32>,   // Directional x=0,y=1; spot PCF receiver x=0,y=far
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
For WebGPU directional lights, `depthValues = (0, 1)`. For spot PCF receiver sampling, `depthValues = (0, far)`, matching Babylon.js `SpotLight.getDepthMinZ()/getDepthMaxZ()` in WebGPU half-Z mode.

### ESM Material Shadow View Fragment Output

The caster material's normal fragment logic runs first, including alpha test, `DiscardBlock`, and clip-plane discard. The ESM shadow view then replaces the final color output with the fixed ESM encoding:

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

### Shadow Depth Vertex Shader — PCF

PCF no longer owns a custom position-only depth vertex shader. `ShadowTask` renders casters through Standard/PBR/Node no-color shadow material views, so the normal material vertex path handles mesh features such as morph targets, skeletons, thin instances, UV-dependent alpha tests, and future material vertex extensions. No-color shadow variants emit a void fragment stage when discard logic is required; no color attachment or dummy texture is bound. Bias is baked into the task scene UBO's light-space view-projection matrix; PCF does not use WebGPU pipeline depth-bias state.

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

### Frame-Graph Scheduling

`registerSceneWithShadowSupport(scene)` installs an internal frame-graph `ShadowTask` before the default swapchain scene render task. Shadow textures are owned by each `ShadowGenerator`; shadow rendering is owned by `ShadowTask`. On every frame, `ShadowTask.execute()` reads `engine._currentEncoder`, loops `scene.lights`, and renders each light's shadow generator. The returned draw counts are summed by `FrameGraph.execute()` together with the scene render task.

ESM generators expose their depth/blur resources to `ShadowTask`. Caster meshes are registered as `ShadowTask` inputs. During `record()`, PCF creates a depth-only `RenderTask` over the generator's depth texture; ESM creates an ESM color+depth `RenderTask` over its task resources. Both paths create one shadow material view per unique caster material.

### ESM Initialization (once)

1. Create shadow params UBO (bias, depthScale, depthValues)
2. Create 4 GPU textures: ESM target, depth buffer, blur-H target, blur-V target
3. Create blur pipeline, blur UBOs, and blur bind groups
4. Create shared receiver shadow UBO
5. Store ESM-only task resources via the internal resource map
6. Return `ShadowGenerator` with `_shadowType: 'esm'`

Scene setup separately registers caster meshes as `ShadowTask` inputs via `setShadowTaskCasterMeshes()`.

### PCF Initialization

1. Create single depth-only texture (`depth32float`, RENDER_ATTACHMENT + TEXTURE_BINDING)
2. Create comparison sampler (`compare: 'less'`, linear filtering)
3. Create shadow params UBO (bias, texel size, depthValues)
4. Register caster meshes as `ShadowTask` inputs; the task wraps the generator's depth texture in a depth-only render target
5. Return `ShadowGenerator` with `shadowType: 'pcf'`

### Per-Frame Rendering — ESM (`ShadowTask`)

```
Recompute light matrix → update shared receiver shadow UBO if dirty

Pass 1: Shadow Depth
  ├─ Clear esmTexture to (0,0,0,0), depthBuf to 1.0
  ├─ Build/record a material-view RenderTask from ShadowTask caster inputs
  └─ Draw each caster through the material renderable path

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

### Per-Frame Rendering — PCF (`ShadowTask`)

```
ShadowTask.record()
  ├─ Create one Standard/PBR/Node no-color shadow MaterialView per unique caster material
  ├─ Create a depth-only RenderTask targeting the generator's depth texture
  └─ Add each caster mesh to the task with its no-color shadow material view

ShadowTask.execute()
  ├─ Recompute spot or directional light matrix if the light/caster state is dirty
  ├─ Update the shared receiver shadow UBO
  └─ Execute the depth-only RenderTask

Pass 1: Shadow Depth (single pass, depth-only)
  ├─ colorAttachments: []  (no color output)
  ├─ Clear depthTexture to 1.0
  ├─ Set group(0) = task scene UBO (biased light viewProjection)
  └─ Draw each caster through the material renderable path

Returns: casters.length  (depth draws only — no blur passes)
```

## Babylon.js Equivalence Map

| Babylon Lite                                        | Babylon.js                                                            |
|-----------------------------------------------------|-----------------------------------------------------------------------|
| `createEsmDirectionalShadowGenerator()`            | `new ShadowGenerator(mapSize, light)` with directional ESM config    |
| `createPcfSpotlightShadowGenerator()`              | `new ShadowGenerator(mapSize, light)` with spotlight PCF config      |
| `createPcfDirectionalShadowGenerator()`            | `new ShadowGenerator(mapSize, light)` with directional PCF config    |
| `ShadowGenerator._shadowType === 'esm'`            | `ShadowGenerator.useBlurExponentialShadowMap = true`                 |
| `ShadowGenerator._shadowType === 'pcf'`            | `ShadowGenerator.usePercentageCloserFiltering = true`                |
| `EsmDirectionalShadowGeneratorConfig.mapSize`       | `ShadowGenerator.mapSize`                                            |
| `EsmDirectionalShadowGeneratorConfig.depthScale`    | `ShadowGenerator.depthScale`                                         |
| `EsmDirectionalShadowGeneratorConfig.bias`          | `ShadowGenerator.bias`                                               |
| `EsmDirectionalShadowGeneratorConfig.blurScale`     | `ShadowGenerator.blurScale`                                          |
| `EsmDirectionalShadowGeneratorConfig.darkness`      | `ShadowGenerator.darkness`                                           |
| `EsmDirectionalShadowGeneratorConfig.frustumEdgeFalloff` | `ShadowGenerator.frustumEdgeFalloff`                           |
| `EsmDirectionalShadowGeneratorConfig.forceRefreshEveryFrame` | Force shadow-map rendering for dynamic/deforming casters      |
| `PcfSpotlightShadowGeneratorConfig.normalBias` / `PcfDirectionalShadowGeneratorConfig.normalBias` | `ShadowGenerator.normalBias` |
| ESM encoding (`exp(-depthScale*d)`)                | `ShadowGenerator.useBlurExponentialShadowMap = true`                 |
| 33-tap Gaussian blur (kernel=64)                   | `ShadowGenerator.useKernelBlur = true; .blurKernel = 64`            |
| PCF 5×5 bilinear (9 optimised taps)               | `ShadowGenerator.filteringQuality = SM_PCF`                         |
| `_computeDirectionalLightMatrix()`                 | `DirectionalLight._setDefaultAutoExtendShadowProjectionMatrix()`     |
| `_computeSpotLightMatrix()`                        | `SpotLight._setDefaultShadowProjectionMatrix()`                      |
| `shadowOrthoScale = 0.1` (expand)                  | `DirectionalLight.shadowOrthoScale = 0.1`                           |
| Directional `depthValues = [0, 1]`                 | `DirectionalLight.getDepthMinZ()=0`, `getDepthMaxZ()=1` (WebGPU half-Z) |
| Spot PCF `depthValues = [0, far]`                  | `SpotLight.getDepthMinZ()=0`, `getDepthMaxZ()=far` (WebGPU half-Z)  |
| `setShadowTaskCasterMeshes()`                      | `ShadowGenerator.addShadowCaster(mesh)` render-list input equivalent|
| `ShadowTask.execute()`                             | Scene/frame orchestration before receiver rendering                 |
| ESM `ShadowGenerator._depthTexture`                 | `ShadowGenerator.getShadowMap()` (after blur passes)                |
| `_lightMatrix`                                      | `ShadowGenerator.getTransformMatrix()`                              |
| `writeShadowUboFields()`                           | Internal UBO packing in Babylon's shadow system                      |
| `ShadowGenerator._version`                         | No direct equivalent — Lite uses version for dirty tracking          |

---

## Dependencies

### shadow-base.ts
- `../mesh/mesh.js` — `Mesh`, `MeshInternal` interfaces

### esm-directional-shadow-generator.ts (ESM)
- `../light/directional-light.js` — `DirectionalLight` interface
- `../engine/engine.js` — `Engine`, `EngineInternal`
- `./shadow-base.js` — shared shadow params and receiver UBO helpers
- `../../shaders/shadow-blur.vertex.wgsl` — blur vertex shader (raw import)

### pcf-spotlight-shadow-generator.ts (PCF)
- `../light/spot-light.js` — `SpotLight` interface
- `../engine/engine.js` — `Engine`, `EngineInternal`
- `./shadow-base.js` — shared light matrix, matrix multiply, shadow UBO/params helpers
- `./shadow-generator.js` — `ShadowGenerator` type
- `./pcf-shadow-task-hooks.js` — shared PCF task preload/state/render helpers

### pcf-directional-shadow-generator.ts (Directional PCF)
- `../light/directional-light.js` — `DirectionalLight` interface
- `../mesh/mesh.js` — `Mesh` interface for caster AABB fitting
- `../engine/engine.js` — `Engine`, `EngineInternal`
- `./shadow-base.js` — shared light matrix, matrix multiply, shadow UBO/params helpers
- `./shadow-generator.js` — `ShadowGenerator` type
- `./pcf-shadow-task-hooks.js` — shared PCF task preload/state/render helpers and PCF task state types

### pcf-shadow-task-hooks.ts
- `../frame-graph/render-task.js` — internal material-view render task used for PCF depth passes
- `./shadow-base.js` — shared caster-version, camera, render-target, and receiver UBO helpers
- `./shadow-generator.js` — `ShadowGenerator` and task-state contracts

### frame-graph/shadow-task.ts
- `../engine/engine.js` — `EngineContext`, `EngineContextInternal`
- `../scene/scene-core.js` — `SceneContext`, `SceneContextInternal`
- `./task.js` — `Task`
- `./shadow-inputs.js` — task-owned caster mesh input accessors

---

## Test Specification

1. **ESM light matrix computation** — Given a directional light at direction `(-1, -3, 2)` with caster meshes, verify the computed view-projection matrix produces correct NDC coordinates for known world points.
2. **ESM encoding** — For depth value 0.5 and depthScale 50: `exp(-min(87, 50 * 0.5)) = exp(-25) ≈ 1.389e-11 ≈ 0` (clamped). For depth 0.01: `exp(-0.5) ≈ 0.6065`.
3. **Blur weight normalization** — Sum of all 33 weights (26 bilinear + 7 dependent) should equal ≈ 1.0.
4. **ESM render pass count** — `ShadowTask` should encode exactly 3 ESM render passes; return value = `casters.length + 2`.
5. **PCF render pass count** — `ShadowTask` should execute exactly 1 depth-only render task per dirty PCF shadow map; return value = `casters.length`.
6. **Texture dimensions** — ESM with `mapSize=1024, blurScale=2`: ESM is 1024², blur textures are 512². PCF with `mapSize=512`: depth texture is 512².
7. **UBO sizes** — Scene: 64B, shadow params: 32B, mesh: 64B, blur: 16B.
8. **ESM default config** — Verify: `mapSize=1024, depthScale=50, bias=0.00005, blurScale=2, darkness=0, frustumEdgeFalloff=0, orthoMinZ=1, orthoMaxZ=10000, forceRefreshEveryFrame=false`.
9. **PCF default config** — Verify: `mapSize=512, bias=0.00005, darkness=0, normalBias=0, near=1, far=10000 or light.range, forceRefreshEveryFrame=false`.
10. **PCF spot light matrix** — Verify perspective projection uses `light.angle` as FOV, 1:1 aspect, correct near/far.
11. **PCF shadowsInfo packing** — `[darkness, mapSize, 1/mapSize, 0]`.
12. **Caster dirty tracking** — After mutating a mesh's worldMatrixVersion, `ShadowTask` detects the task-owned caster input versions and re-executes the material-view render task.
12b. **Forced refresh** — With `forceRefreshEveryFrame=true`, `ShadowTask` re-executes the PCF material-view render task even if light and caster world matrix versions are unchanged, covering morph targets and other GPU-driven deformations.
13. **writeShadowUboFields** — Output Float32Array(24) matches expected layout: [lightMatrix×16, depthValues.x, depthValues.y, 0, 0, shadowsInfo×4].

---

## File Manifest

| File | Role |
|------|------|
| `src/shadow/shadow-base.ts` | Shared shadow math, params UBO, receiver UBO, and `writeShadowUboFields()` helpers |
| `src/shadow/shadow-generator.ts` | Shared `ShadowGenerator` contract |
| `src/shadow/esm-directional-shadow-generator.ts` | Directional ESM generator — shadow params UBO, ESM/depth/blur textures, blur pipeline, receiver UBO, task resource accessors, and directional AABB-fit matrix helper |
| `src/shadow/pcf-spotlight-shadow-generator.ts` | Spot PCF shadow generator — factory function, spot light matrix helper, depth texture/comparison sampler ownership, and spot receiver depth values |
| `src/shadow/pcf-directional-shadow-generator.ts` | Directional PCF shadow generator — factory function, directional AABB-fit matrix helper, depth texture/comparison sampler ownership, and directional receiver depth values |
| `src/frame-graph/shadow-inputs.ts` | Public caster-mesh input registration for shadow tasks |
| `src/frame-graph/shadow-task.ts` | Internal frame-graph task that schedules shadows before receiver rendering and renders PCF/ESM casters via Standard/PBR/Node shadow material views |
| `src/shadow/pcf-shadow-task-hooks.ts` | Shared PCF preload/state/render hooks used by spot and directional PCF generators |
| `shaders/shadow-blur.vertex.wgsl` | Blur vertex shader: fullscreen triangle generation + UV computation |
The spot matrix helper lives in `shadow/pcf-spotlight-shadow-generator.ts`.
