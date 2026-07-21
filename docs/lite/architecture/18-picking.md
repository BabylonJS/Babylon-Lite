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
    pickedNormal: [number, number, number] | null; // local-space, set by detailed picking
    pickedNormalWorld: [number, number, number] | null;
    pickedFaceNormal: [number, number, number] | null;
    pickedFaceNormalWorld: [number, number, number] | null;
    pickedMesh: Mesh | GaussianSplattingMesh | null; // GS meshes resolve here too, via their pick contributor
    faceId: number; // -1 if no detailed picking
    bu: number; // barycentric u
    bv: number; // barycentric v
    subMeshId: number;
    thinInstanceIndex: number; // -1 if not thin instance
    ray: Ray | null; // the pick ray, set when detailed picking ran
    _spritePick?: BillboardPickInfo; // billboard hit payload, set by the billboard pick contributor (read by pickBillboardSprite)
}

// GpuPicker is pure state — used via the standalone functions below, never as methods.
interface GpuPicker {
    _scene: SceneContext;
    _detailedPick: ((info: PickingInfo, ray: Ray) => void | Promise<void>) | null;
    _contributors: Map<PickSource, PickContributor> | null; // built once per pick source, cached
    // + lazily-allocated 1×1 render targets, scene UBO, and scene bind group
}

interface Ray {
    origin: [number, number, number];
    direction: [number, number, number];
    length: number;
}

interface PickOptions {
    filter?: (mesh: Mesh) => boolean;
    discard?: PickDiscardRule;
    debugLabel?: string;
}

type PickVertexDataAttribute = "normal" | "uv" | "uv2" | "tangent" | "color";

interface PickDiscardRule {
    readonly key: string;
    readonly wgsl: string;
    readonly storage?: readonly PickDiscardStorage[];
    /** Optional regular-mesh vertex attribute exposed to the discard predicate.
     *  Missing components and meshes without the requested buffer read as zero. Thin instances
     *  always read zero here and keep their per-instance payload in `instanceExtras`. */
    readonly vertexData?: PickVertexDataAttribute;
}

// WGSL shape injected when PickDiscardRule.vertexData is set.
// Rules without vertexData keep the legacy shape without that field.
struct PickDiscardInput {
    worldPos: vec3f,
    fragmentCoord: vec2f, // selected pixel center in the original backing framebuffer
    pickId: u32,
    thinInstanceIndex: u32,
    hasThinInstance: u32,
    instanceExtras: vec4f,
    vertexData: vec4f,
}
```

### Functions

```typescript
/** Create a GPU picker bound to a scene (pure state; render targets are allocated on the first pick). */
function createGpuPicker(scene: SceneContext): GpuPicker;

/** Run one pick at pixel (x, y) on the picker's scene surface. `options` can filter meshes,
 *  inject a GPU discard rule, or set a debug label. */
function pickAsync(picker: GpuPicker, x: number, y: number, options?: PickOptions): Promise<PickingInfo>;

/** Free the picker's GPU resources (render targets, scene UBO, and each cached contributor's state). */
function disposePicker(picker: GpuPicker): void;

/** Enable detailed picking (Phase 2 CPU ray-triangle) on an existing GPU picker. */
function enableDetailedPicking(picker: GpuPicker): void;

/** Interpolate the normal at the picked point using barycentric coords. */
function getPickedNormal(info: PickingInfo, useWorldCoordinates?: boolean): [number, number, number] | null;

/** Interpolate the UV at the picked point using barycentric coords. */
function getPickedUV(info: PickingInfo): [number, number] | null;
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
2. A WGSL shader writes the 24-bit pick ID as RGB at `@location(0)` and the fragment's NDC depth at `@location(1)`.
3. The pass uses a **pick-zoomed view-projection** so only the picked pixel survives, drawing all meshes to a **1×1** target: two colour attachments (`rgba8unorm` pick ID + `r32float` NDC depth) plus a `depth24plus` depth buffer (reverse-Z, compare `greater`). Because the 1×1 fragment position is always `(0.5, 0.5)`, the scene UBO separately carries the selected pixel center in original backing-framebuffer coordinates for custom discard WGSL.
4. The 1×1 pick-ID and depth texels are copied to staging buffers and read back.
5. The pick ID is decoded: `(r << 16) | (g << 8) | b`.
6. The world-space hit point is reconstructed by unprojecting NDC + the read-back depth through `inverse(VP)`.

### Optional regular-mesh vertex data

A `PickDiscardRule` may name one existing mesh attribute through `vertexData`.
The picker then selects a cached regular-mesh pipeline variant whose second vertex buffer reads that
attribute and forwards it flat to `PickDiscardInput.vertexData` as a padded `vec4f`:

| Attribute | GPU format  | `vertexData` projection |
| --------- | ----------- | ----------------------- |
| `normal`  | `float32x3` | `(x, y, z, 0)`          |
| `uv`      | `float32x2` | `(x, y, 0, 0)`          |
| `uv2`     | `float32x2` | `(x, y, 0, 0)`          |
| `tangent` | `float32x4` | `(x, y, z, w)`          |
| `color`   | `float32x4` | `(r, g, b, a)`          |

The forwarding is `@interpolate(flat)`, so categorical payloads remain exact within a triangle.
If a regular mesh does not own the requested GPU attribute, the picker uses the position-only pipeline
and supplies `vec4f(0.0)`; known zero-filled placeholder UV buffers (`hasUv === false`) are not bound.
Interleaved glTF buffers use their recorded stride and byte offset for both position and the selected
attribute. The forwarded value is the raw source-buffer value: skinning and morph deformation do not
transform normals or tangents for this generic payload. Thin-instance picking likewise supplies zero
`vertexData`; its existing `instanceExtras` field remains the generic per-instance payload. This keeps
the feature optional, adds no vertex-buffer binding to default tight picks, and does not make the
picker interpret consumer data.

The shader snippets, attribute lookup, and tight/interleaved pipeline-variant cache live in
`picking-vertex-data.ts`. `pickAsync` dynamically imports that module only when a discard rule requests
`vertexData` or a picked mesh has an interleaved position buffer. Ordinary tight picking keeps the
original position-only shader and fetches no vertex-data feature chunk.

### Pick Vertex World Adjustment (Internal Shader Hook)

`picking-shader.ts` accepts an internal `PickingShaderOptions.worldAdjustWgsl`
source override. The source must define:

```wgsl
fn adjustPickWorld(worldPos: vec3f, instanceExtras: vec4f, thinInstanceIndex: u32) -> vec3f
```

The default implementation returns `worldPos` unchanged. Both mesh shader
variants call the hook after their affine world transform and before
view-projection:

- Regular meshes pass zero `instanceExtras` and `0xffffffffu` as the
  non-instance sentinel.
- Thin instances pass the four spare matrix `w` lanes and the actual
  `instanceIndex`.

This is a shader-source composition seam, not a root `PickOptions` API. Internal
specialized picking pipelines can use it to mirror world-space vertex
displacement from their visible shader. Storage declarations supplied through
the same `PickingShaderOptions.storage` array are visible to the injected WGSL;
the owning pipeline must expose those bindings to the vertex stage.

### Pick contributors (optional entity types)

The picker draws meshes itself (Phase 1, ids `1..M`), then iterates
`scene._pickSources` — a generic list of `PickSource` records (`{ entity, load }`,
`pick-contributor.ts`) — with no knowledge of any specific entity type. Each
_optional_ pickable entity registers one source when it is added to the scene: a
Gaussian-splatting mesh (`attachGaussianSplattingMesh`, one id per mesh) and a
billboard sprite system (`addFacingBillboardSystem` /
`addAxisLockedBillboardSystem`, `system.count` ids). A source is pure data plus a
dynamic-`import()` thunk — no pick behaviour is bound at registration. On the first
pick the picker `load()`s each source's pipeline, calls its
`createPickContributor(entity)` to build the handler, and caches the result in
`picker._contributors`. Contributors draw into the **same** 1×1 pass against the
**same** depth target, so they depth-sort against meshes and each other; each owns
a contiguous id range `[base, next)` that the picker records for resolve. Adding a
new pickable type is a new module that calls `registerPickSource` — no edits to
`gpu-picker.ts` or `scene-core.ts`.

Because a source carries no pick-behaviour code, _rendering_ a billboard or GS
entity pulls no pick-pipeline bytes (just the entity reference + the import thunk)
— only the picker (on the first pick) imports `gs-picking-pipeline.ts` /
`billboard-pick-pipeline.ts`, builds the contributor, and caches its per-picker GPU
resources in the contributor closure (freed generically via each contributor's
optional `dispose`). A scene with no such entities fetches zero contributor-pick
bytes; a scene that never picks fetches no picking code at all. On resolve a GS
contributor sets `info.pickedMesh` (the hit point comes from the shared depth
readback) and a billboard sets `info._spritePick`; detailed CPU ray picking (Phase 2) runs only for regular mesh hits.

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

### Render Targets (1×1, non-MSAA, created lazily on first pick)

The pass renders through a pick-zoomed view-projection into a **1×1** target, so
each attachment is a single texel:

- **Pick-ID colour**: `rgba8unorm`, usage `RENDER_ATTACHMENT | COPY_SRC` — the 24-bit id.
- **Depth colour**: `r32float`, usage `RENDER_ATTACHMENT | COPY_SRC` — the fragment's NDC depth, written at `@location(1)` (a colour attachment so it can be `COPY_SRC`'d back).
- **Depth buffer**: `depth24plus`, usage `RENDER_ATTACHMENT` — the actual depth test (reverse-Z, cleared to `0`, compare `greater`); not copied.
- **Staging buffers**: 2 × 256 bytes (`MAP_READ | COPY_DST`) for the 1-pixel id + depth readback. 256 bytes is the minimum `bytesPerRow` for `copyTextureToBuffer`.

### Vertex Layout

- Default tight regular/thin-instance paths: one position `float32x3` buffer, stride 12, shader location 0.
- A discard rule with `vertexData` adds a cached regular-mesh pipeline variant with one second buffer
  at shader location 5. Its format follows the table above, while tight or interleaved stride/offset
  come from the mesh. The variant is selected only when the current mesh owns that attribute;
  otherwise the position-only variant supplies zero.
- Interleaved regular and thin-instance positions use cached position-layout variants even without `vertexData`.
- No extra buffer is bound for default tight picks or thin instances.

### Bind Groups

**Regular meshes:**
| Group | Binding | Type | Content |
|-------|---------|------|---------|
| 0 | 0 | uniform | `mat4x4f` viewProjection + `vec2f` original fragment coordinate (shared, 80 bytes) |
| 1 | 0 | uniform | `mat4x4f` world + `u32` pickId (80 bytes, 16-aligned) |

**Thin-instanced meshes:**
| Group | Binding | Type | Content |
|-------|---------|------|---------|
| 0 | 0 | uniform | `mat4x4f` viewProjection + `vec2f` original fragment coordinate (shared, 80 bytes) |
| 1 | 0 | uniform | `u32` baseMeshPickId (16 bytes, padded) |
| 1 | 1 | read-only-storage | `array<mat4x4f>` — instance world matrices |

### Depth / Stencil

- Format: `depth24plus`
- Compare: `greater` (reverse-Z; depth cleared to `0`)
- Write: enabled
- No stencil

### Primitive State

- Topology: `triangle-list`
- Cull mode: `back`
- Front face: `ccw`
- Multisample count: `1` (no MSAA — exact pixel ID matching required)

### Pipeline Caching

- Cached per-device via `device !== _cachedDevice` invalidation pattern.
- Every set has regular position-only and thin-instance variants. A discard rule naming `vertexData`
  lazily creates regular attribute variants in `picking-vertex-data.ts`. The rule key must change when
  its WGSL, storage layout, or vertex-data attribute changes.

## Shader Logic (WGSL — Phase 1)

```wgsl
// Vertex — regular mesh
@vertex fn vs(@location(0) pos: vec3f) -> @builtin(position) vec4f {
    return viewProjection * world * vec4f(pos, 1.0);
}

// Optional discard-data variant (example: tangent; other attributes are padded to vec4f).
@vertex fn vsWithData(@location(0) pos: vec3f,
                      @location(5) tangent: vec4f) -> VsOut {
    // world/pick fields omitted here; vertexData is forwarded flat.
    out.vertexData = tangent;
}

// Vertex — thin instances (instance_index selects matrix from storage)
@vertex fn vsTI(@location(0) pos: vec3f,
                @builtin(instance_index) iid: u32) -> @builtin(position) vec4f {
    let m = tiMatrices[iid];
    return viewProjection * m * vec4f(pos, 1.0);
}

// Fragment — pick ID as RGB at @location(0), NDC depth at @location(1)
struct FsOut { @location(0) color: vec4f, @location(1) depth: f32 }
@fragment fn fs(@builtin(position) pos: vec4f) -> FsOut {
    let r = f32((pickId >> 16u) & 0xFFu) / 255.0;
    let g = f32((pickId >> 8u)  & 0xFFu) / 255.0;
    let b = f32(pickId & 0xFFu) / 255.0;
    return FsOut(vec4f(r, g, b, 1.0), pos.z);
}
```

## Lifecycle

1. **Create**: `createGpuPicker(scene)` → pure state; render targets allocated on the first pick.
2. **Enable detail** (optional): `enableDetailedPicking(picker)` → installs the `_detailedPick` hook.
3. **Pick**: `pickAsync(picker, x, y, options?)` →
    - draws meshes, then iterates `scene._pickSources`, into the 1×1 pass → reads back the id + depth texels → resolves the mesh/contributor + world point
    - if `_detailedPick` is set and a regular mesh was hit: constructs a ray → runs CPU intersection → sets `faceId`/`bu`/`bv`
4. **Dispose**: `disposePicker(picker)` → destroys render targets, scene UBO, and per-contributor GPU state.

## Babylon.js Equivalence Map

| BJS API                               | Babylon Lite              |
| ------------------------------------- | ------------------------- |
| `scene.pick(x, y)`                    | `pickAsync(picker, x, y)` |
| `pickingInfo.hit`                     | `info.hit`                |
| `pickingInfo.pickedMesh`              | `info.pickedMesh`         |
| `pickingInfo.pickedPoint`             | `info.pickedPoint`        |
| `pickingInfo.distance`                | `info.distance`           |
| `pickingInfo.faceId`                  | `info.faceId`             |
| `pickingInfo.bu`                      | `info.bu`                 |
| `pickingInfo.bv`                      | `info.bv`                 |
| `pickingInfo.thinInstanceIndex`       | `info.thinInstanceIndex`  |
| `pickingInfo.getNormal()`             | `getPickedNormal(info)`   |
| `pickingInfo.getTextureCoordinates()` | `getPickedUV(info)`       |

## Dependencies

- `../math/types.js` — `Mat4` type
- `../math/mat4-invert.js` — `mat4Invert`
- `./pick-contributor.js` — `PickContributor` seam (optional pickable entities register here)
- `../mesh/mesh.js` — `Mesh` interface (CPU geometry fields)
- `../scene/scene.js` — `SceneContext` (for camera + mesh list)
- `../mesh/thin-instance.js` — `ThinInstanceData` (matrix subarray)

## Test Specification

Covered today by unit tests (`picking-discard-api`, `pick-sprite-2d`, `billboard-pick`)
and the parity scenes 113-115, 117, 118, 129 (real WebGPU). The cases below enumerate
the intended coverage.

### Unit Tests

- **Pick ID encoding round-trip**: encode u32 → RGB floats → RGBA8 readback → decode u32 = original.
- **World-adjust shader hook**: identity by default; custom WGSL is injected exactly once in regular/thin shaders; regular meshes receive the non-instance sentinel and thin instances receive packed extras + `instanceIndex`.
- **Discard vertex data**: every supported attribute generates the correct second-buffer layout and WGSL padding; regular meshes with the buffer forward it flat, regular meshes without it and all thin instances supply zero; default rules retain the position-only layout.
- **Interleaved picking layouts**: regular/thin-instance positions and requested discard attributes use the mesh's recorded stride/offset; placeholder UV buffers are not treated as real attributes.
- **Ray unprojection**: `createPickingRay` at canvas center with identity VP should produce Z-forward ray.
- **Möller–Trumbore**: known triangle + ray → expected `t`, `u`, `v`. Edge cases: parallel, behind, grazing.
- **Barycentric interpolation**: known face normals/UVs + known `bu`/`bv` → expected interpolated values.

### Integration Tests (WebGPU, parity harness)

- **Single mesh pick**: create sphere, pick at center → `hit=true`, `pickedMesh` matches, `distance > 0`.
- **Background miss**: pick at corner with no meshes → `hit=false`.
- **Multi-mesh**: two meshes, pick each → correct mesh identified.
- **Thin instance**: mesh with thin instances, pick specific instance → correct `thinInstanceIndex`.
- **Detailed picking**: enable detailed, pick sphere → `faceId >= 0`, `bu + bv <= 1`.
- **Depth accuracy**: pick known-distance mesh → `info.distance` within 1% of expected.

## File Manifest

| File                         | Role                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `picking-info.ts`            | `PickingInfo` interface + `createEmptyPickingInfo`                                 |
| `ray.ts`                     | `Ray` interface + `createPickingRay`                                               |
| `gpu-picker.ts`              | `GpuPicker` — GPU ID pass, depth readback, Phase 2 hook                            |
| `pick-contributor.ts`        | `PickContributor` seam — optional pickable entities (GS, billboards) register here |
| `gs-picking-pipeline.ts`     | GS pick pipeline (lazy-imported by the GS pick contributor)                        |
| `billboard-pick-pipeline.ts` | Billboard pick pipeline (lazy-imported by the billboard pick contributor)          |
| `deformed-geometry.ts`       | Deformed CPU positions (morph/skeleton) for picking animated meshes                |
| `picking-pipeline.ts`        | Cached GPU pipeline + bind group layouts for pick pass                             |
| `picking-shader.ts`          | WGSL shader source for pick pass                                                   |
| `picking-vertex-data.ts`     | Lazy regular-mesh attribute/interleaved-layout picking extension                   |
| `detailed-picking.ts`        | `enableDetailedPicking` — CPU ray-triangle (Möller–Trumbore)                       |
| `picking-helpers.ts`         | `getPickedNormal`, `getPickedUV` — barycentric interpolation                       |
