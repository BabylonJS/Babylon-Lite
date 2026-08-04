# Module: Picking

> Package path: `packages/babylon-lite/src/picking/`

## Purpose

GPU-accelerated identification and surface picking. Every pick renders the selected
screen pixel into a 1×1 offscreen target, reads back the winning ID and depth, and
reconstructs the world-space point. On adapters exposing the optional WebGPU
`primitive-index` feature, `createEngine` requests it at device creation and
`enableDetailedPicking` activates an exact GPU detail attachment containing the
winning primitive index and interpolated local position. Unsupported devices keep
detailed picking inactive; there is no CPU triangle-search fallback.

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
    _detailedPicking: boolean;
    _contributors: Map<PickSource, PickContributor> | null; // built once per pick source, cached
    // + lazily-allocated 1×1 ID/depth/detail targets, scene UBO, and scene bind group
}

interface Ray {
    origin: [number, number, number];
    direction: [number, number, number];
    length: number;
}

interface PickOptions {
    filter?: (mesh: Mesh) => boolean;
    /** Exclude visible identities while selecting the surface behind them.
     *  Omit thin fields to exclude a regular mesh or all thin instances;
     *  provide one index or a contiguous range to discard only those instances. */
    ignore?: PickIgnore | readonly PickIgnore[];
    discard?: PickDiscardRule;
    debugLabel?: string;
}

interface PickIgnore {
    readonly mesh: Mesh;
    readonly thinInstanceIndex?: number;
    readonly thinInstanceRange?: { readonly start: number; readonly count: number };
}

type PickVertexDataAttribute = "normal" | "uv" | "uv2" | "tangent" | "color";

interface PickDiscardStorage {
    readonly name: string;
    readonly type: string;
    /** Opt this binding into vertex-stage visibility when worldAdjustWgsl reads it. */
    readonly vertex?: boolean;
    readonly data: (mesh: Mesh) => ArrayBufferView | null | undefined;
}

interface PickDiscardRule {
    readonly key: string;
    readonly wgsl: string;
    /** Optional vertex-stage hook that returns the world position used for projection and fragment discard. */
    readonly worldAdjustWgsl?: string;
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

struct PickWorldInput {
    worldPos: vec3f,          // affine world transform of localPos before custom displacement
    localPos: vec3f,          // position read by the current pick pipeline
    basis0: vec3f,            // affine world basis column 0
    basis1: vec3f,            // affine world basis column 1
    basis2: vec3f,            // affine world basis column 2
    origin: vec3f,            // affine world translation column
    instanceExtras: vec4f,    // thin-instance matrix w lanes; zero for regular meshes
    thinInstanceIndex: u32,   // actual index or 0xffffffffu for a regular mesh
    hasThinInstance: u32,     // 1 for thin instances, otherwise 0
    vertexData: vec4f,        // selected regular-mesh attribute or zero
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

/** Enable exact GPU primitive details when the device has the requested `primitive-index` feature.
 *  Unsupported devices leave the picker in basic mode. */
function enableDetailedPicking(picker: GpuPicker): void;

/** Interpolate the normal at the picked point using barycentric coords. */
function getPickedNormal(info: PickingInfo, useWorldCoordinates?: boolean): [number, number, number] | null;

/** Interpolate the UV at the picked point using barycentric coords. */
function getPickedUV(info: PickingInfo): [number, number] | null;
```

### Mesh CPU Geometry Fields (on `Mesh` interface)

```typescript
_cpuPositions?: Float32Array;  // retained positions for barycentric reconstruction
_cpuNormals?: Float32Array;    // retained normals for interpolation
_cpuUvs?: Float32Array;        // retained UVs for interpolation
_cpuIndices?: Uint32Array;     // retained indices for exact primitive lookup
```

Populated automatically by `createMeshFromData` (mesh factories), glTF loader,
and .babylon loader. No copies needed — the arrays already exist in JS memory.

## Internal Architecture

### GPU Pick Pass

1. Each mesh (or thin instance) is assigned a sequential pick ID (1-based; 0 = miss).
2. A WGSL shader writes the 24-bit pick ID as RGB at `@location(0)` and the fragment's NDC depth at `@location(1)`.
3. The pass uses a **pick-zoomed view-projection** so only the picked pixel survives, drawing all meshes to a **1×1** target: two colour attachments (`rgba8unorm` pick ID + `r32float` NDC depth) plus a `depth24plus` depth buffer (reverse-Z, compare `greater`). Because the 1×1 fragment position is always `(0.5, 0.5)`, the scene UBO separately carries the selected pixel center in original backing-framebuffer coordinates for custom discard WGSL.
4. Detailed mode adds one `rgba32uint` attachment. Mesh fragments write
   `(primitiveIndex, bitcast(localX), bitcast(localY), bitcast(localZ))`.
   Billboard and Gaussian-splat contributors write `0xffffffff` as the primitive sentinel.
5. The 1×1 texels are copied to reusable staging buffers and read back.
6. The pick ID is decoded: `(r << 16) | (g << 8) | b`.
7. The world-space point is reconstructed by unprojecting the same selected pixel center and read-back depth through `inverse(VP)`. The optional ray uses that exact center too.
8. Mesh ID ranges are snapshotted while commands are recorded, so scene mutation during asynchronous readback cannot remap the returned ID.

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

Vertex-data/world-adjust shader generation, attribute lookup, and tight/interleaved
pipeline variants all live in the unified `picking-shader.ts` / `picking-pipeline.ts`
owner. The cache key includes the rule key, selected attribute, storage-stage layout,
detailed/basic mode, and vertex-buffer stride/offset.

### Pick Vertex World Adjustment

`PickDiscardRule.worldAdjustWgsl` lets a caller mirror visible vertex displacement in the pick pass.
The source must define:

```wgsl
fn adjustPickWorld(input: PickWorldInput) -> vec3f
```

The default returns `input.worldPos` unchanged. Regular and thin-instance shaders call the hook after
their affine world transform and before view-projection. The returned position is used for projection
and becomes `PickDiscardInput.worldPos`, so the fragment predicate observes the displaced surface.
Regular meshes provide zero `instanceExtras` and the `0xffffffffu` non-instance sentinel; thin
instances provide the four spare matrix `w` lanes and their actual instance index. When `vertexData`
is selected, regular meshes expose the same padded source attribute to both `PickWorldInput` and
`PickDiscardInput`; missing attributes and thin instances provide zero.

Storage declarations are fragment-visible by default. Set a storage entry's `vertex: true` only when
`worldAdjustWgsl` reads that binding; Lite then uses `VERTEX | FRAGMENT` visibility for that entry. This
keeps fragment-only discard data out of the vertex-stage storage limit while still allowing both hooks
to share selected per-mesh data. The caller must change `PickDiscardRule.key` whenever either WGSL source
or its storage/vertex layout changes so cached pipelines remain valid.

Thin-instance inputs use the same composed transform as visible rendering: `mesh.world * instanceWorld`.
The four packed matrix `w` lanes are exposed separately as `instanceExtras` and are forced to
`0,0,0,1` in the affine transform. World-adjusted detailed picks retain the GPU depth, exact
primitive index, displaced world point, barycentrics, and UV interpolation. Because arbitrary caller
WGSL may rotate or non-uniformly deform the surface without a CPU normal contract, interpolated and
face normals are deliberately unavailable (`getPickedNormal` / `getPickedFaceNormal` return `null`)
for world-adjusted hits.

### Exact GPU Detailed Results

`primitive_index` is an optional device feature, not an unconditional WGSL language feature.
`createEngine` checks `adapter.features` and adds `"primitive-index"` to
`requestDevice({ requiredFeatures })` when available. Device-loss recovery captures and
re-requests that same feature set. `enableDetailedPicking` activates only when
`device.features.has("primitive-index")`; otherwise it is a no-op.

For a mesh hit, the detail attachment identifies the exact indexed triangle and its
interpolated local surface point. Lite computes barycentric weights only within that known
triangle—there is no scan or ray/triangle intersection—and uses the retained/deformed
positions plus source vertex normals to populate `faceId`, `bu`, `bv`, local/world interpolated
normal, and local/world face normal. This matches Babylon.js `PickingInfo.getNormal(..., true)`:
morph/skinned positions are deformed for the hit, while the public vertex-normal interpolation
uses the mesh's source normal data. UV helpers use the same weights. Thin-instance normal
transforms rebuild the same affine instance matrix as WGSL, excluding packed `w` payload lanes.

Basic non-deformed picks never read retained CPU positions or normals. This preserves lazy
interleaved glTF CPU accessors and avoids de-striding/allocating arrays that the basic GPU ID/depth
path does not consume.

### Material-Owned Vertex Projection (VAT)

The unified pipeline accepts one optional internal `PickingVertexProjection` supplied lazily by
the visible material feature. VAT is the first projection:

- `gpu-picker.ts` imports `vat-picking-pipeline.ts` only when a pickable mesh has `mesh.vat`.
- `vat-picking-pipeline.ts` asks `vat-fragment.ts` for the same helper functions, frame-row
  selection, 4/8-bone matrix sum, dual-clip blend, and transform order used by visible rendering.
- Regular VAT projects with `mesh.world * influence`.
- Thin VAT projects with `instanceWorld * mesh.world * influence`, matching the visible outer
  instance placement rather than the ordinary affine `mesh.world * instanceWorld` path.
- The projection provides both `projectedWorld` and `projectedTransform`, so
  `PickWorldInput.worldPos`, basis columns, and origin all describe the actual VAT-deformed
  transform before a caller's optional `worldAdjustWgsl`.
- Group 3 owns the VAT texture/settings and optional instance-parameter resource. Groups 0/1
  remain the picker scene/mesh groups; group 2 remains discard storage (or an empty layout).
- Skin vertex buffers are appended after position and optional `vertexData`: joints/weights for
  4-bone skinning, plus joints1/weights1 for 8-bone skinning.
- Thin-instance playback reads either the normal two-texel `instanceTexture` or the authoritative
  public `StorageBuffer` configured by `setVatInstanceStorage`.

VAT projection modules and shader bytes are absent from scenes with no VAT mesh. VAT detailed
picks retain exact primitive/barycentric/UV identity and displaced world depth/point; normals are
unavailable because the CPU does not retain the baked per-frame normal transform.

### Ignore One Visible Identity

`PickOptions.ignore` supports direct-manipulation workflows that need the surface behind one or
more selected objects. A regular mesh (or all of a mesh's thin instances) is omitted from ID
assignment and drawing. One thin instance or one contiguous thin-instance range remains in the
positional ID range but its vertices mark `excluded`, causing the fragment to discard only that
range in the same depth-sorted GPU pass. No second pick or CPU proxy geometry is used.

`Mesh.visible` is intentionally not a pick gate: gizmos use invisible, enlarged collider meshes
that remain pickable. `Mesh.pickable === false`, `PickOptions.filter`, and `ignore` are the explicit
ways to remove a mesh identity from the pass.

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
readback) and a billboard sets `info._spritePick`. Contributors participate in the
third attachment when detailed mode is active but write the primitive sentinel because
their public payloads do not use mesh face/barycentric helpers.

### Barycentric Interpolation (Helpers)

For vertex attribute `A` with per-vertex values `A0, A1, A2`:

```
A_hit = bu * A0 + bv * A1 + (1 - bu - bv) * A2
```

Used for normals (`getPickedNormal`) and UVs (`getPickedUV`).

## Pipeline Configuration

### Render Targets (1×1, non-MSAA, created lazily on first pick)

The pass renders through a pick-zoomed view-projection into a **1×1** target, so
each attachment is a single texel:

- **Pick-ID colour**: `rgba8unorm`, usage `RENDER_ATTACHMENT | COPY_SRC` — the 24-bit id.
- **Depth colour**: `r32float`, usage `RENDER_ATTACHMENT | COPY_SRC` — the fragment's NDC depth, written at `@location(1)` (a colour attachment so it can be `COPY_SRC`'d back).
- **Detail colour (only when active)**: `rgba32uint`, usage `RENDER_ATTACHMENT | COPY_SRC` — primitive index plus bitcast local position.
- **Depth buffer**: `depth24plus`, usage `RENDER_ATTACHMENT` — the actual depth test (reverse-Z, cleared to `0`, compare `greater`); not copied.
- **Staging buffers**: reusable 256-byte (`MAP_READ | COPY_DST`) buffers for ID, depth, and optional detail. 256 bytes is the minimum `bytesPerRow` for `copyTextureToBuffer`.

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
| 1 | 0 | uniform | `mat4x4f` mesh world + `u32` baseMeshPickId + `u32` excludedThinInstance (80 bytes) |
| 1 | 1 | read-only-storage | `array<mat4x4f>` — instance world matrices |

**Discard/world-adjust storage:**

Group 2 contains caller-provided read-only storage bindings. Bindings are fragment-visible
by default; `PickDiscardStorage.vertex: true` additionally exposes only that binding to the
vertex-stage world-adjust hook.

### Depth / Stencil

- Format: `depth24plus`
- Compare: `greater` (reverse-Z; depth cleared to `0`)
- Write: enabled
- No stencil

### Primitive State

- Topology: `triangle-list`
- Cull mode: `none` (matching two-sided `Scene.pick` intersection semantics)
- Front face: `ccw`
- Multisample count: `1` (no MSAA — exact pixel ID matching required)

### Pipeline Caching

- Cached per-device via `device !== _cachedDevice` invalidation pattern.
- Every set has regular position-only and thin-instance variants generated by the same shader owner.
- Detailed sets are created only when the device feature is active and include the third attachment.
- Regular vertex-data and interleaved position variants are cached in `picking-pipeline.ts`.
- The key includes rule identity, storage stage visibility, detailed/basic mode, selected attribute,
  and position/data strides and offsets. The caller must still change `PickDiscardRule.key` when WGSL
  or semantic layout changes.

## Shader Logic (WGSL)

```wgsl
// Detailed variants begin with:
enable primitive_index;

// Vertex — regular mesh
@vertex fn vs(@location(0) pos: vec3f) -> VsOut {
    let baseWorld = (mesh.world * vec4f(pos, 1.0)).xyz;
    let wp = adjustPickWorld(PickWorldInput(...));
    out.p = scene.viewProjection * vec4f(wp, 1.0);
    out.localPos = pos; // detailed variants
}

// Optional discard-data variant (example: tangent; other attributes are padded to vec4f).
@vertex fn vsWithData(@location(0) pos: vec3f,
                      @location(5) tangent: vec4f) -> VsOut {
    // world/pick fields omitted here; vertexData is forwarded flat.
    out.vertexData = tangent;
}

// Vertex — thin instances (packed w lanes are payload, not transform)
@vertex fn vsTI(@location(0) pos: vec3f,
                @builtin(instance_index) iid: u32) -> VsOut {
    let packed = instances[iid];
    let instanceWorld = mat4x4f(
        vec4f(packed[0].xyz, 0.0),
        vec4f(packed[1].xyz, 0.0),
        vec4f(packed[2].xyz, 0.0),
        vec4f(packed[3].xyz, 1.0));
    let world = tiMesh.world * instanceWorld;
    out.excluded = select(0u, 1u, iid == tiMesh.excludedThinInstance);
    // adjustPickWorld + projection as above
}

// Fragment — ID, NDC depth, and optional exact detail.
struct FsOut {
    @location(0) color: vec4f,
    @location(1) depth: f32,
    @location(2) detail: vec4u,
}
@fragment fn fs(input: VsOut,
                @builtin(primitive_index) primitiveIndex: u32) -> FsOut {
    if (input.excluded != 0u) { discard; }
    let r = f32((pickId >> 16u) & 0xFFu) / 255.0;
    let g = f32((pickId >> 8u)  & 0xFFu) / 255.0;
    let b = f32(pickId & 0xFFu) / 255.0;
    return FsOut(
        vec4f(r, g, b, 1.0),
        input.p.z,
        vec4u(primitiveIndex,
              bitcast<u32>(input.localPos.x),
              bitcast<u32>(input.localPos.y),
              bitcast<u32>(input.localPos.z)));
}
```

## Lifecycle

1. **Create**: `createGpuPicker(scene)` → pure state; render targets allocated on the first pick.
2. **Enable detail** (optional): `enableDetailedPicking(picker)` → sets `_detailedPicking` only when the created device has `"primitive-index"`.
3. **Pick**: `pickAsync(picker, x, y, options?)` →
    - snapshots mesh ID ranges and draws meshes, then `scene._pickSources`, into the shared 1×1 pass
    - reads ID + depth (+ exact detail when active), resolves from the snapshot, and reconstructs the pixel-center world point
    - for a detailed mesh hit, derives barycentrics/normals from the exact GPU primitive/local point
4. **Dispose**: `disposePicker(picker)` → destroys ID/depth/detail targets, staging buffers, scene UBO, and per-contributor GPU state.

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
- `../math/mat4-multiply.js` — affine base-mesh × thin-instance composition for detailed normals
- `./pick-contributor.js` — `PickContributor` seam (optional pickable entities register here)
- `../mesh/mesh.js` — `Mesh` interface (CPU geometry fields)
- `../scene/scene.js` — `SceneContext` (for camera + mesh list)
- `../mesh/thin-instance.js` — `ThinInstanceData` (matrix subarray)
- `./deformed-geometry.js` — deformed positions and normals for morph/skinned detailed results
- `../material/pbr/fragments/vat-fragment.js` — material-owned VAT projection shared by visible and pick shaders

## Test Specification

Covered today by unit tests (`picking-discard-api`, `pick-sprite-2d`, `billboard-pick`)
and the parity scenes 113-115, 117, 118, 129 (real WebGPU). The cases below enumerate
the intended coverage.

### Unit Tests

- **Pick ID encoding round-trip**: encode u32 → RGB floats → RGBA8 readback → decode u32 = original.
- **World-adjust shader hook**: identity by default; custom WGSL is injected exactly once in regular/thin shaders; regular meshes receive the non-instance sentinel and thin instances receive packed extras + `instanceIndex`.
- **Discard vertex data**: every supported attribute generates the correct second-buffer layout and WGSL padding; regular meshes with the buffer forward it flat, regular meshes without it and all thin instances supply zero; default rules retain the position-only layout.
- **Interleaved picking layouts**: regular/thin-instance positions and requested discard attributes use the mesh's recorded stride/offset; placeholder UV buffers are not treated as real attributes.
- **Primitive feature gate**: engine device features activate detailed mode only with `"primitive-index"`; unsupported devices remain basic with two attachments and no CPU triangle-search fallback.
- **Exact GPU detail**: detailed shader enables `primitive_index` and packs primitive/local point; readback populates face/barycentric/normal data for basic, world-adjusted, and thin-instance meshes.
- **Async ID snapshot**: visibility/order mutation during staging-buffer mapping cannot remap the winning ID.
- **Ignore identity**: full-mesh ignore consumes no ID; one thin-instance ignore writes the exact excluded index to the UBO.
- **Packed thin extras**: nonzero matrix `w` payload lanes do not corrupt detailed world normals.
- **Deformed detail**: morph/skinned picks interpolate deformed positions and deformed normals.
- **VAT projection**: regular/thin, texture/StorageBuffer, 4/8-bone variants reuse visible VAT
  deformation and bind group 3 without changing affine picker layouts.
- **Ray unprojection**: `createPickingRay` at canvas center with identity VP should produce Z-forward ray.
- **Barycentric interpolation**: known face normals/UVs + known `bu`/`bv` → expected interpolated values.

### Integration Tests (WebGPU, parity harness)

- **Single mesh pick**: create sphere, pick at center → `hit=true`, `pickedMesh` matches, `distance > 0`.
- **Background miss**: pick at corner with no meshes → `hit=false`.
- **Multi-mesh**: two meshes, pick each → correct mesh identified.
- **Thin instance**: mesh with thin instances, pick specific instance → correct `thinInstanceIndex`.
- **Detailed picking**: when the adapter exposes `"primitive-index"`, verify engine creation requested it, detailed mode is active, and a sphere pick returns exact `faceId` with `bu + bv <= 1`; otherwise verify detailed mode remains inactive.
- **World-adjusted detail**: displaced sphere remains a positive hit with displaced depth/point and exact face ID on supported devices.
- **Depth accuracy**: pick known-distance mesh → `info.distance` within 1% of expected.

## File Manifest

| File                         | Role                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `picking-info.ts`            | `PickingInfo` interface + `createEmptyPickingInfo`                                 |
| `ray.ts`                     | `Ray` interface + `createPickingRay`                                               |
| `gpu-picker.ts`              | GPU ID/depth/detail pass, snapshot resolve, detailed surface decode, ignore handling |
| `pick-contributor.ts`        | `PickContributor` seam — optional pickable entities (GS, billboards) register here |
| `gs-picking-pipeline.ts`     | GS pick pipeline (lazy-imported by the GS pick contributor)                        |
| `billboard-pick-pipeline.ts` | Billboard pick pipeline (lazy-imported by the billboard pick contributor)          |
| `deformed-geometry.ts`       | Deformed CPU positions/normals matching the GPU pick geometry                      |
| `picking-pipeline.ts`        | Unified cached pipeline/layout owner for every mesh pick variant                   |
| `picking-shader.ts`          | Unified WGSL generator for basic/detailed, regular/thin, data/adjust variants       |
| `vat-picking-pipeline.ts`    | Lazy VAT projection layouts/bindings; reuses VAT material WGSL                     |
| `detailed-picking.ts`        | `enableDetailedPicking` gate + lazy exact-primitive detail decoder                  |
| `picking-helpers.ts`         | `getPickedNormal`, `getPickedUV` — barycentric interpolation                       |
