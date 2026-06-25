# Module: Picking

> Package path: `packages/babylon-lite/src/picking/`

## Purpose

GPU-accelerated mesh identification with optional CPU-side detailed picking.
Phase 1 renders mesh IDs to an offscreen render target, reads back a single pixel
to identify the picked mesh, and reconstructs the world-space pick point from depth.
Phase 2 (optional) performs CPU ray-triangle intersection on the identified mesh
to provide `faceId`, barycentric coordinates (`bu`, `bv`), and helper functions
for interpolating normals and UVs at the hit point.

## Public API Surface

### Types

```typescript
interface PickingInfo {
    hit: boolean;
    distance: number;
    pickedPoint: [number, number, number] | null;
    pickedMesh: Mesh | null;
    faceId: number; // -1 if no detailed picking
    bu: number; // barycentric u
    bv: number; // barycentric v
    subMeshId: number;
    thinInstanceIndex: number; // -1 if not thin instance
}

interface GpuPicker {
    pickAsync(x: number, y: number): Promise<PickingInfo>;
    _detailedPick: ((info: PickingInfo, ray: Ray) => void) | null;
    dispose(): void;
}

interface Ray {
    origin: [number, number, number];
    direction: [number, number, number];
    length: number;
}
```

### Functions

```typescript
/** Create a GPU picker bound to a scene. */
function createGpuPicker(scene: SceneContext): GpuPicker;

/** Enable detailed picking (Phase 2) on an existing GPU picker. */
function enableDetailedPicking(picker: GpuPicker): void;

/** Interpolate the normal at the picked point using barycentric coords. */
function getPickedNormal(info: PickingInfo, useWorldCoordinates?: boolean): [number, number, number] | null;

/** Interpolate the UV at the picked point using barycentric coords. */
function getPickedUV(info: PickingInfo): [number, number] | null;

/** Create a picking ray from screen coordinates and VP matrix. */
function createPickingRay(x: number, y: number, vpMatrix: Mat4, width: number, height: number): Ray | null;
```

### Mesh CPU Geometry Fields (on `Mesh` interface)

```typescript
_cpuPositions?: Float32Array;  // retained positions for ray-triangle
_cpuNormals?: Float32Array;    // retained normals for interpolation
_cpuUvs?: Float32Array;        // retained UVs for interpolation
_cpuIndices?: Uint32Array;     // retained indices for ray-triangle
```

Populated automatically by `createMeshFromData` (mesh factories), glTF loader,
and .babylon loader. No copies needed — the arrays already exist in JS memory.

## Internal Architecture

### Phase 1: GPU Mesh Identification

1. Each mesh (or thin instance) is assigned a sequential pick ID (1-based; 0 = miss).
2. A flat-color WGSL shader writes `vec4f(r, g, b, 1)` where RGB encodes the 24-bit pick ID.
3. A single render pass draws all meshes to an offscreen `rgba8unorm` + `depth32float` target.
4. One pixel at `(px, py)` is copied to staging buffers and read back.
5. The pick ID is decoded: `(r << 16) | (g << 8) | b`.
6. The world-space hit point is reconstructed by unprojecting NDC + depth through `inverse(VP)`.

### Phase 2: CPU Ray-Triangle Intersection

1. A picking ray is constructed from the screen pixel via `createPickingRay`.
2. For the identified mesh, each triangle is transformed to world space
   (using `mesh.worldMatrix` or the thin instance matrix).
3. Möller–Trumbore intersection finds the closest hit triangle.
4. The result populates `info.faceId`, `info.bu`, `info.bv`.

### Möller–Trumbore Algorithm

Given ray `(O, D)` and triangle `(V0, V1, V2)`:

```
E1 = V1 - V0,  E2 = V2 - V0
H  = D × E2
det = E1 · H
if |det| < ε: parallel → miss
S = O - V0
u = (S · H) / det   — if u ∉ [0,1]: miss
Q = S × E1
v = (D · Q) / det   — if v < 0 or u+v > 1: miss
t = (E2 · Q) / det  — if t < ε: behind ray → miss
```

### Barycentric Interpolation (Helpers)

For vertex attribute `A` with per-vertex values `A0, A1, A2`:

```
A_hit = (1 - bu - bv) * A0 + bu * A1 + bv * A2
```

Used for normals (`getPickedNormal`) and UVs (`getPickedUV`).

## Pipeline Configuration

### Render Targets (non-MSAA, created lazily on first pick)

- **Color**: `rgba8unorm`, usage `RENDER_ATTACHMENT | COPY_SRC`, canvas resolution
- **Depth**: `depth32float`, usage `RENDER_ATTACHMENT | COPY_SRC`, canvas resolution
  (`depth32float` chosen over `depth24plus` because WebGPU allows `COPY_SRC` on float depth)
- **Staging buffers**: 2 × 256 bytes (`MAP_READ | COPY_DST`) for 1-pixel color + depth readback.
  256 bytes is the minimum `bytesPerRow` for `copyTextureToBuffer`.

### Vertex Layout

- Single buffer: position `float32x3`, stride 12, shader location 0
- No normals, UVs, or tangents needed — picking only cares about geometry position.

### Bind Groups

**Regular meshes:**
| Group | Binding | Type | Content |
|-------|---------|------|---------|
| 0 | 0 | uniform | `mat4x4f` — viewProjection (shared, 64 bytes) |
| 1 | 0 | uniform | `mat4x4f` world + `u32` pickId (80 bytes, 16-aligned) |

**Thin-instanced meshes:**
| Group | Binding | Type | Content |
|-------|---------|------|---------|
| 0 | 0 | uniform | `mat4x4f` — viewProjection (shared) |
| 1 | 0 | uniform | `u32` baseMeshPickId (16 bytes, padded) |
| 1 | 1 | read-only-storage | `array<mat4x4f>` — instance world matrices |

### Depth / Stencil

- Format: `depth32float`
- Compare: `greater`
- Write: enabled
- No stencil

### Primitive State

- Topology: `triangle-list`
- Cull mode: `back`
- Front face: `ccw`
- Multisample count: `1` (no MSAA — exact pixel ID matching required)

### Pipeline Caching

- Cached per-device via `device !== _cachedDevice` invalidation pattern.
- Two pipeline variants: regular and thin-instance (separate shader modules + bind group layouts).

## Shader Logic (WGSL — Phase 1)

```wgsl
// Vertex — regular mesh
@vertex fn vs(@location(0) pos: vec3f) -> @builtin(position) vec4f {
    return viewProjection * world * vec4f(pos, 1.0);
}

// Vertex — thin instances (instance_index selects matrix from storage)
@vertex fn vsTI(@location(0) pos: vec3f,
                @builtin(instance_index) iid: u32) -> @builtin(position) vec4f {
    let m = tiMatrices[iid];
    return viewProjection * m * vec4f(pos, 1.0);
}

// Fragment — encode pick ID as RGB
@fragment fn fs() -> @location(0) vec4f {
    let r = f32((pickId >> 16u) & 0xFFu) / 255.0;
    let g = f32((pickId >> 8u)  & 0xFFu) / 255.0;
    let b = f32(pickId & 0xFFu) / 255.0;
    return vec4f(r, g, b, 1.0);
}
```

## Lifecycle

1. **Create**: `createGpuPicker(scene)` → allocates render targets on first pick.
2. **Enable detail** (optional): `enableDetailedPicking(picker)` → installs `_detailedPick` hook.
3. **Pick**: `picker.pickAsync(x, y)` →
    - Renders ID pass → reads pixel → decodes mesh + depth
    - If `_detailedPick` set: constructs ray → runs CPU intersection → sets faceId/bu/bv
4. **Dispose**: `picker.dispose()` → destroys render targets and staging buffers.

## Babylon.js Equivalence Map

| BJS API                               | Babylon Lite             |
| ------------------------------------- | ------------------------ |
| `scene.pick(x, y)`                    | `picker.pickAsync(x, y)` |
| `pickingInfo.hit`                     | `info.hit`               |
| `pickingInfo.pickedMesh`              | `info.pickedMesh`        |
| `pickingInfo.pickedPoint`             | `info.pickedPoint`       |
| `pickingInfo.distance`                | `info.distance`          |
| `pickingInfo.faceId`                  | `info.faceId`            |
| `pickingInfo.bu`                      | `info.bu`                |
| `pickingInfo.bv`                      | `info.bv`                |
| `pickingInfo.thinInstanceIndex`       | `info.thinInstanceIndex` |
| `pickingInfo.getNormal()`             | `getPickedNormal(info)`  |
| `pickingInfo.getTextureCoordinates()` | `getPickedUV(info)`      |

## Dependencies

- `../math/types.js` — `Mat4` type
- `../math/mat4.js` — `mat4Invert`
- `../mesh/mesh.js` — `Mesh` interface (CPU geometry fields)
- `../scene/scene.js` — `SceneContext` (for camera + mesh list)
- `../mesh/thin-instance.js` — `ThinInstanceData` (matrix subarray)

## Test Specification

### Unit Tests (future)

- **Pick ID encoding round-trip**: encode u32 → RGB floats → RGBA8 readback → decode u32 = original.
- **Ray unprojection**: `createPickingRay` at canvas center with identity VP should produce Z-forward ray.
- **Möller–Trumbore**: known triangle + ray → expected `t`, `u`, `v`. Edge cases: parallel, behind, grazing.
- **Barycentric interpolation**: known face normals/UVs + known `bu`/`bv` → expected interpolated values.

### Integration Tests (future — requires WebGPU context)

- **Single mesh pick**: create sphere, pick at center → `hit=true`, `pickedMesh` matches, `distance > 0`.
- **Background miss**: pick at corner with no meshes → `hit=false`.
- **Multi-mesh**: two meshes, pick each → correct mesh identified.
- **Thin instance**: mesh with thin instances, pick specific instance → correct `thinInstanceIndex`.
- **Detailed picking**: enable detailed, pick sphere → `faceId >= 0`, `bu + bv <= 1`.
- **Depth accuracy**: pick known-distance mesh → `info.distance` within 1% of expected.

## File Manifest

| File                  | Role                                                         |
| --------------------- | ------------------------------------------------------------ |
| `picking-info.ts`     | `PickingInfo` interface + `createEmptyPickingInfo`           |
| `ray.ts`              | `Ray` interface + `createPickingRay`                         |
| `gpu-picker.ts`       | `GpuPicker` — GPU ID pass, depth readback, Phase 2 hook      |
| `picking-pipeline.ts` | Cached GPU pipeline + bind group layouts for pick pass       |
| `picking-shader.ts`   | WGSL shader source for pick pass                             |
| `detailed-picking.ts` | `enableDetailedPicking` — CPU ray-triangle (Möller–Trumbore) |
| `picking-helpers.ts`  | `getPickedNormal`, `getPickedUV` — barycentric interpolation |
