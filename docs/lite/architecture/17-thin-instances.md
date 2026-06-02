# Module: Thin Instances
> Package path: `packages/babylon-lite/src/mesh/` (data + GPU sync), `packages/babylon-lite/src/material/standard/` + `packages/babylon-lite/src/material/pbr/` (rendering)

## Purpose

Thin instances allow a single mesh to be drawn thousands of times with unique per-instance world matrices and optional per-instance RGBA colors, using a single instanced draw call. This is the primary mechanism for rendering large crowds, particle-like effects, and procedural grids. The system is split into three layers — CPU data model, GPU buffer sync, and material integration — designed so that **scenes that don't use thin instances pay zero bundle-size cost**.

---

## Public API Surface

### Interfaces

```typescript
/** Per-mesh thin-instance state. Stored as mesh.thinInstances. */
export interface ThinInstanceData {
  matrices: Float32Array;          // 16 floats per instance (row-major 4×4 world matrix)
  count: number;                   // active instance count
  _capacity: number;               // allocated capacity (≥ count)
  _version: number;                // bumped by every mutating helper; checked by render system
  _gpuBuffer: GPUBuffer | null;    // matrix GPU buffer, managed by render system
  _gpuVersion: number;             // last _version uploaded to GPU
  colors?: Float32Array | null;    // optional RGBA per instance (4 floats each)
  _colorVersion: number;           // independent of _version; bumped by setThinInstanceColors
  _colorGpuBuffer: GPUBuffer | null;
  _colorGpuVersion: number;
}
```

### Functions — CPU Data Model (`thin-instance.ts`)

```typescript
/** Bulk-set all instance matrices. Creates ThinInstanceData if absent. */
export function setThinInstances(mesh: Mesh, matrices: Float32Array, count: number): void;

/** Add one instance. Returns the new instance index. Grows capacity 2× when full. */
export function addThinInstance(mesh: Mesh, matrix: Mat4): number;

/** Overwrite the matrix at a specific index. */
export function setThinInstanceMatrix(mesh: Mesh, index: number, matrix: Mat4): void;

/** Remove instance at index via swap-remove (last instance moves into the gap). */
export function removeThinInstance(mesh: Mesh, index: number): void;

/** Bump _version after direct manipulation of the matrices Float32Array. */
export function flushThinInstances(mesh: Mesh): void;

/** Set per-instance RGBA colors. Bumps _colorVersion. */
export function setThinInstanceColors(mesh: Mesh, colors: Float32Array): void;
```

### Functions — GPU Sync (`thin-instance-gpu.ts`)

```typescript
/**
 * Sync CPU thin-instance data to GPU vertex buffers and bind them to the render pass.
 * Returns the next free vertex buffer slot.
 */
export function syncThinInstanceBuffers(
  device: GPUDevice,
  ti: ThinInstanceData,
  pass: GPURenderPassEncoder,
  slot: number,
  hasColor: boolean,
): number;
```

### Feature Flag Constants

```typescript
// standard-pipeline.ts
export const THIN_INSTANCES      = 1 << 15;  // matrix instancing
export const THIN_INSTANCE_COLOR = 1 << 16;  // per-instance color buffer
export const DISABLE_LIGHTING    = 1 << 17;  // skip light loop, output emissive × diffuse × baseColor

// mesh-features.ts
export const MSH_HAS_THIN_INSTANCES = 1 << 4;
export const MSH_HAS_INSTANCE_COLOR = 1 << 5;
```

### Material Property

```typescript
// StandardMaterialProps — extended with:
disableLighting: boolean;  // default false. When true, skip all lighting; output emissive * diffuse * baseColor.
```

---

## Internal Architecture

### Data Flow

```
User code
  │  setThinInstances(mesh, matrices, count)
  │  setThinInstanceColors(mesh, colors)
  ▼
thin-instance.ts  →  mesh.thinInstances: ThinInstanceData
  │  _version / _colorVersion bumped on every mutation
  ▼
standardGroupBuilder (standard-material.ts)
  │  detects meshes.some(m => !!m.thinInstances)
  │  dynamic import('./thin-instance-gpu.js')  ← lazy-loaded chunk
  │  passes syncThinInstanceBuffers as tiSync callback
  ▼
buildStandardMeshRenderables (standard-renderable.ts)
  │  stores tiSync in the draw closure
  ▼
Per-frame draw
  │  if (mesh.thinInstances && tiSync):
  │    slot = tiSync(device, ti, pass, slot, hasInstanceColor)
  │    pass.drawIndexed(indexCount, ti.count)  ← instanced draw
  ▼
GPU vertex shader
  │  world0..world3 → instanceWorld → finalWorld = mesh.world * instanceWorld
  │  instanceColor → vInstanceColor varying
  ▼
GPU fragment shader
  │  lighting or disableLighting path
  │  final color.rgba *= vInstanceColor.rgba (if instance color)
```

### Capacity Growth & Swap-Remove

**Capacity growth** — `addThinInstance` starts at capacity 16. When `count === _capacity`, a new `Float32Array` is allocated at `_capacity * 2` and the old data is copied:

```typescript
const newCap = ti._capacity * 2;
const newData = new Float32Array(newCap * 16);
newData.set(ti.matrices);
ti.matrices = newData;
ti._capacity = newCap;
```

**Swap-remove** — `removeThinInstance` copies the last instance matrix into the removed slot using `copyWithin`, then decrements count:

```typescript
ti.matrices.copyWithin(index * 16, last * 16, last * 16 + 16);
ti.count--;
ti._version++;
```

This avoids shifting the entire array, keeping removal O(1). Callers must be aware that the last instance's index changes.

### Version Tracking

| Version field | Bumped by | Checked by |
|---|---|---|
| `_version` | `setThinInstances`, `addThinInstance`, `setThinInstanceMatrix`, `removeThinInstance`, `flushThinInstances` | `syncThinInstanceBuffers` (matrix upload) |
| `_colorVersion` | `setThinInstanceColors` | `syncThinInstanceBuffers` (color upload) |
| `_gpuVersion` | `syncThinInstanceBuffers` (after matrix upload) | — |
| `_colorGpuVersion` | `syncThinInstanceBuffers` (after color upload) | — |

GPU upload is skipped when `_version === _gpuVersion` (or `_colorVersion === _colorGpuVersion`), avoiding redundant `writeBuffer` calls for static instances.

---

## GPU Buffer Sync (`thin-instance-gpu.ts`)

### Matrix Buffer

1. Compare `ti._version !== ti._gpuVersion` — skip if equal.
2. Compute `byteSize = ti.count * 64` (16 floats × 4 bytes).
3. If `ti._gpuBuffer` is null or `ti._gpuBuffer.size < byteSize`:
   - Destroy old buffer (if any).
   - Create new buffer: `size = ti._capacity * 64`, `usage = VERTEX | COPY_DST`.
4. `device.queue.writeBuffer(ti._gpuBuffer, 0, ti.matrices.buffer, ti.matrices.byteOffset, byteSize)`.
5. Set `ti._gpuVersion = ti._version`.
6. Bind: `pass.setVertexBuffer(slot++, ti._gpuBuffer)`.

### Color Buffer (conditional: `hasColor && ti.colors`)

1. Compare `ti._colorVersion !== ti._colorGpuVersion` — skip if equal.
2. Compute `byteSize = ti.count * 16` (4 floats × 4 bytes).
3. If `ti._colorGpuBuffer` is null or `ti._colorGpuBuffer.size < byteSize`:
   - Destroy old buffer (if any).
   - Create new buffer: `size = ti._capacity * 16`, `usage = VERTEX | COPY_DST`.
4. `device.queue.writeBuffer(ti._colorGpuBuffer, 0, ti.colors.buffer, ti.colors.byteOffset, byteSize)`.
5. Set `ti._colorGpuVersion = ti._colorVersion`.
6. Bind: `pass.setVertexBuffer(slot++, ti._colorGpuBuffer)`.

### Return Value

Returns the updated `slot` number — the next free vertex buffer slot after all thin-instance buffers have been bound.

---

## Pipeline Configuration

### Feature Flag Logic

`computeFeatures(material, receiveShadows)` sets:

```typescript
if (material.disableLighting) f |= DISABLE_LIGHTING;
```

The renderable builder sets:

```typescript
if (mesh.thinInstances)        features |= THIN_INSTANCES;
if (mesh.thinInstances.colors) features |= THIN_INSTANCE_COLOR;
```

### Vertex Buffer Layouts

Base per-vertex attributes use sequential `shaderLocation` values starting at 0:

| Location | Attribute | Format | Stride | Step Mode |
|---|---|---|---|---|
| 0 | position | `float32x3` | varies | vertex |
| 1 | normal | `float32x3` | varies | vertex |
| 2 (opt) | uv | `float32x2` | varies | vertex |
| next (opt) | uv2 | `float32x2` | varies | vertex |

When `THIN_INSTANCES` is set, an instanced buffer layout is appended:

```typescript
{
  arrayStride: 64,        // 4 × vec4<f32> = 4 × 16 bytes
  stepMode: 'instance',
  attributes: [
    { shaderLocation: nextAttr++, offset: 0,  format: 'float32x4' },  // world0 (row 0)
    { shaderLocation: nextAttr++, offset: 16, format: 'float32x4' },  // world1 (row 1)
    { shaderLocation: nextAttr++, offset: 32, format: 'float32x4' },  // world2 (row 2)
    { shaderLocation: nextAttr++, offset: 48, format: 'float32x4' },  // world3 (row 3)
  ],
}
```

When `THIN_INSTANCE_COLOR` is set, another instanced buffer layout is appended:

```typescript
{
  arrayStride: 16,        // 1 × vec4<f32>
  stepMode: 'instance',
  attributes: [
    { shaderLocation: nextAttr++, offset: 0, format: 'float32x4' },  // instanceColor (RGBA)
  ],
}
```

---

## Shader Logic

### Vertex Shader

**Instance matrix attributes** (when `THIN_INSTANCES`):

```wgsl
@location(N)   world0: vec4<f32>,
@location(N+1) world1: vec4<f32>,
@location(N+2) world2: vec4<f32>,
@location(N+3) world3: vec4<f32>,
```

**Instance color attribute** (when `THIN_INSTANCE_COLOR`):

```wgsl
@location(M) instanceColor: vec4<f32>,
```

**World matrix composition**:

```wgsl
let instanceWorld = mat4x4<f32>(world0, world1, world2, world3);
let finalWorld = mesh.world * instanceWorld;
```

`finalWorld` replaces `mesh.world` in all subsequent vertex transforms (position, normal).

**Instance color passthrough** (varying):

```wgsl
// Vertex output struct
@location(K) vInstanceColor: vec4<f32>,

// Vertex main
out.vInstanceColor = instanceColor;
```

### Fragment Shader

**Normal lighting path** (`DISABLE_LIGHTING` not set):

Standard Blinn-Phong lighting loop (diffuse, specular, ambient, emissive, shadows). After composition, if `THIN_INSTANCE_COLOR`:

```wgsl
color = vec4<f32>(
  color.rgb * input.vInstanceColor.rgb,
  color.a * input.vInstanceColor.a
);
```

**Disabled lighting path** (`DISABLE_LIGHTING` set):

Skips: lighting function definitions, light loop, shadow sampling, ambient, reflection, lightmap. Emits:

```wgsl
var color = vec4<f32>(
  clamp(emissiveContrib * diffuseColor, vec3<f32>(0.0), vec3<f32>(1.0)) * baseColor.rgb,
  alpha
);
```

Then, if `THIN_INSTANCE_COLOR`, the same instance-color multiplication is applied:

```wgsl
color = vec4<f32>(
  color.rgb * input.vInstanceColor.rgb,
  color.a * input.vInstanceColor.a
);
```

---

## Renderable Integration (`standard-renderable.ts`)

### tiSync Callback Type

```typescript
type ThinInstanceSync = (
  device: GPUDevice,
  ti: ThinInstanceData,
  pass: GPURenderPassEncoder,
  slot: number,
  hasColor: boolean,
) => number;
```

### Draw Function

`buildStandardMeshRenderables` accepts an optional `tiSync` callback. In the per-mesh draw closure:

```typescript
const ti = mesh.thinInstances;
if (ti && tiSync) {
  slot = tiSync(device, ti, pass, slot, hasInstanceColor);
  pass.drawIndexed(g.indexCount, ti.count);
} else {
  pass.drawIndexed(g.indexCount);
}
```

The instanced `drawIndexed(indexCount, instanceCount)` draws all instances in a single GPU call.

---

## Dynamic Loading Architecture (`standard-material.ts`)

### Group Builder

The `standardGroupBuilder` function detects thin instances at build time:

```typescript
const hasTI = meshes.some(m => !!m.thinInstances);
let tiSync;
if (hasTI) {
  const mod = await import('../../mesh/thin-instance-gpu.js');
  tiSync = mod.syncThinInstanceBuffers;
}
const { buildStandardMeshRenderables } = await import('./standard-renderable.js');
return buildStandardMeshRenderables(scene, meshes, tiSync);
```

This ensures `thin-instance-gpu.ts` is only fetched when a scene actually uses thin instances.

### Bundle Size Impact

The thin instance feature is designed for **zero bundle-size impact on scenes that don't use it**:

| Layer | Cost | When Loaded |
|---|---|---|
| `thin-instance.ts` (CPU data model) | ~1 KB | Only if user imports `setThinInstances()` etc. |
| `thin-instance-gpu.ts` (GPU sync) | ~0.9 KB | Dynamic import, only when `standardGroupBuilder` detects thin instances |
| Shader/pipeline feature flag checks | ~400 bytes | Always present in standard shader composer (unavoidable — feature flags are checked in shared composition functions) |

Scene 16 chunk breakdown: `scene16.js` (18.1 KB) + `standard-renderable` (22.5 KB) + `thin-instance-gpu` (0.9 KB) = 41.5 KB total.

---

## State Machine / Lifecycle

### Initialization

1. User calls `setThinInstances(mesh, matrices, count)` or `addThinInstance(mesh, matrix)`.
2. `ThinInstanceData` is created on `mesh.thinInstances` with initial capacity.
3. Optionally, user calls `setThinInstanceColors(mesh, colors)` for per-instance RGBA.

### Per-Frame Render

```
1. standardGroupBuilder detects mesh.thinInstances
2. Dynamically imports thin-instance-gpu.ts (cached after first load)
3. Passes syncThinInstanceBuffers as tiSync to buildStandardMeshRenderables
4. For each mesh with thinInstances:
   a. tiSync checks _version vs _gpuVersion
   b. Creates / resizes GPU buffer if needed (capacity × 64 bytes for matrices)
   c. writeBuffer from CPU Float32Array → GPU
   d. Bumps _gpuVersion = _version
   e. setVertexBuffer(slot, matrixBuffer); slot++
   f. If hasColor: same flow for color buffer (capacity × 16 bytes); slot++
   g. drawIndexed(indexCount, ti.count)
```

### Mutation (Runtime)

- `addThinInstance` → grows capacity 2× if full, copies old data, bumps `_version`.
- `removeThinInstance` → swap-removes (O(1)), bumps `_version`.
- `setThinInstanceMatrix` → overwrites 16 floats in-place, bumps `_version`.
- `flushThinInstances` → bumps `_version` only (for direct array manipulation).
- `setThinInstanceColors` → replaces colors array, bumps `_colorVersion`.

---

## PBR Material Integration

PBR thin instances are fully implemented. The system mirrors the Standard material path but uses the ShaderFragment composition system:

### Fragment-Based Integration

`pbr-renderable.ts` detects thin instances at build time and dynamically imports the thin-instance fragment:

```typescript
if (meshes.some(m => !!m.thinInstances)) {
    const { createThinInstanceFragment } = await import('../../shader/fragments/thin-instance-fragment.js');
    fragments.push(createThinInstanceFragment(hasInstanceColor));
    const { syncThinInstanceBuffers } = await import('../../mesh/thin-instance-gpu.js');
    tiSync = syncThinInstanceBuffers;
}
```

### Thin Instance Fragment (`shader/fragments/thin-instance-fragment.ts`)

The fragment contributes:
- **Vertex attributes**: `world0..world3` (instance matrix rows) + optional `instanceColor`
- **Vertex slot**: Composes `finalWorld = mesh.world * instanceWorld` — replaces the mesh world matrix in all subsequent transforms
- **Fragment slot**: Multiplies base color/alpha by instance color (when `MSH_HAS_INSTANCE_COLOR` is set)

### Draw Path

```typescript
if (ti && tiSync) {
    slot = tiSync(device, ti, pass, slot, hasInstanceColor);
    pass.drawIndexed(indexCount, ti.count);
}
```

The same GPU sync function (`syncThinInstanceBuffers`) is shared between Standard and PBR paths.

### Scene 17

Scene 17 (`scene17-pbr-std-thin-instances`) validates PBR thin instances: a PBR box with 2 thin instances + per-instance colors, alongside Standard material thin instances in the same scene.

---

## Babylon.js Equivalence Map

| Babylon Lite | Babylon.js |
|---|---|
| `setThinInstances(mesh, matrices, count)` | `mesh.thinInstanceSetBuffer("matrix", data, 16)` |
| `setThinInstanceColors(mesh, colors)` | `mesh.thinInstanceSetBuffer("color", data, 4)` |
| `addThinInstance(mesh, matrix)` | `mesh.thinInstanceAdd(matrix)` |
| `removeThinInstance(mesh, index)` | `mesh.thinInstanceRemove(index)` |
| `setThinInstanceMatrix(mesh, index, matrix)` | `mesh.thinInstanceSetMatrixAt(index, matrix)` |
| `flushThinInstances(mesh)` | `mesh.thinInstanceBufferUpdated("matrix")` |
| `material.disableLighting = true` | `material.disableLighting = true` |
| `THIN_INSTANCES` feature flag | Internal `#define THIN_INSTANCES` |
| `THIN_INSTANCE_COLOR` feature flag | Internal `#define THIN_INSTANCE_COLOR` |
| Per-instance color via vertex attribute | Per-instance color via vertex attribute |
| `finalWorld = mesh.world * instanceWorld` | `finalWorld = world * instanceWorld` |
| Swap-remove with `copyWithin` | Swap-remove with buffer manipulation |
| Dynamic import of GPU sync module | Always loaded (no code splitting) |

**Same math, minimal code.** No class hierarchy — just typed arrays, version counters, and a GPU sync function.

---

## Dependencies

- WebGPU instanced drawing (`drawIndexed(indexCount, instanceCount)`)
- WebGPU vertex buffer `stepMode: 'instance'`
- `device.queue.writeBuffer` for CPU → GPU transfer
- Standard material shader composition (feature-flag-driven WGSL generation)
- Dynamic `import()` for lazy chunk loading

---

## Test Specification

| Test | Description |
|---|---|
| Scene 16 parity | Pixel comparison of 64K colored cubes against Babylon.js reference |
| Live reference | Opens `babylon-ref-scene16.html`, captures `live-ref.png`, compares against Lite |
| Golden fallback | Falls back to `babylon-ref-golden.png` if live capture fails |
| MAD threshold | Full-image Mean Absolute Difference ≤ 1 |
| Exact match ratio | ≥ 95% of pixels must be exact matches |
| Capacity growth | `addThinInstance` beyond initial capacity → doubles array, preserves existing data |
| Swap-remove correctness | `removeThinInstance(i)` → last instance moves to slot `i`, count decrements |
| Version skip | Static instances: GPU upload skipped when `_version === _gpuVersion` |
| Color independence | Matrix mutation does not trigger color re-upload (separate version counters) |
| Zero-cost loading | Scenes without thin instances never fetch `thin-instance-gpu.js` chunk |

---

## File Manifest

| File | Purpose |
|---|---|
| `src/mesh/thin-instance.ts` | CPU-side data model + public API (`ThinInstanceData`, `setThinInstances`, etc.) |
| `src/mesh/thin-instance-gpu.ts` | GPU buffer sync — lazy-loaded chunk (`syncThinInstanceBuffers`) |
| `src/material/standard/standard-material.ts` | `disableLighting` property + `standardGroupBuilder` with dynamic sync loading |
| `src/material/standard/standard-pipeline.ts` | `THIN_INSTANCES`, `THIN_INSTANCE_COLOR`, `DISABLE_LIGHTING` flags + pipeline vertex buffer layouts |
| `src/material/standard/standard-template.ts` | `instanceColor` varying + `disableLighting` fragment path + instance world matrix composition |
| `src/material/standard/standard-renderable.ts` | `tiSync` callback integration + instanced `drawIndexed` |
| `src/material/mesh-features.ts` | `MSH_HAS_THIN_INSTANCES`, `MSH_HAS_INSTANCE_COLOR` feature flag constants |
| `src/material/pbr/pbr-renderable.ts` | PBR thin-instance detection, fragment loading, instanced draw |
| `src/material/pbr/pbr-pipeline.ts` | PBR pipeline vertex buffer layouts for thin instances |
| `src/shader/fragments/thin-instance-fragment.ts` | ShaderFragment for instance matrix/color — shared by PBR and Standard |
| `lab/lite/src/lite/scene16.ts` | Reference scene: 40×40×40 = 64K colored cubes with `disableLighting` |
| `lab/lite/src/lite/scene17.ts` | Reference scene: PBR + Standard thin instances in one scene |
| `tests/lite/parity/scene16-thin-instances.spec.ts` | Parity test for Standard thin instances |
| `tests/lite/parity/scene17-pbr-std-thin-instances.spec.ts` | Parity test for PBR + Standard thin instances |

---

## Limitations

- **No per-instance custom data** — only world matrix and RGBA color are supported as instance attributes.
- **Swap-remove reorders instances** — removing an instance changes the index of the last instance. Callers managing external index mappings must account for this.
- **Max 4 floats per color** — RGBA only, no HDR or extended per-instance data.
- **No frustum culling per instance** — all `ti.count` instances are drawn unconditionally.
