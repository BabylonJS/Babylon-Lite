# Module: In-place Mesh Geometry Update

> Package path: `packages/babylon-lite/src/mesh/mesh-factories.ts`

## Purpose

Update every attribute and the index data of an existing tightly-packed procedural mesh while its
vertex/index counts and attribute layout remain unchanged. GPU buffer identities stay stable, so
cached render and shadow bundles remain valid. CPU geometry, bounds, detailed picking, and
device-loss recovery are updated atomically with the GPU contents.

Topology growth or shrinkage may use either `resizeMeshGeometry`, which replaces exact-size buffers and
invalidates cached bundles safely, `resizeSharedMeshGeometry`, which performs one upload and keeps a
clone family on one reference-counted geometry object, or `updateMeshGeometryCapacity`, which reserves
grow-only capacity and keeps the inactive index tail degenerate so live procedural edits retain stable buffer identities and draw topology.

## Public API Surface

### Exact active draw ranges (opt-in)

```ts
export interface MeshDrawRange {
    readonly vertices: MeshGeometryRange;
    readonly indices: MeshGeometryRange;
}
export function setMeshDrawRange(engine: EngineContext, mesh: Mesh, range: MeshDrawRange): void;
```

`setMeshDrawRange` selects initialized, retained geometry within owned, unshared, tightly-packed
uint32 buffers. It does not upload, allocate, retire, or replace GPU buffers. Offsets and counts are
elements, not bytes: `indices.offset` is WebGPU `firstIndex`, `indices.count` is the exact
`drawIndexed` count, and `vertices.offset` is `baseVertex`. Selected indices must be relative to the
selected vertex window (`0 <= index < vertices.count`). Both ranges are explicit, finite,
nonnegative integers within retained source lengths and physical capacity; baseVertex must fit int32.
Zero counts are valid; nonempty indices require nonempty vertices. Counts need not be multiples of
three, so point-list and line-list materials can use the same API. Mesh geometry is always indexed,
including point lists; this API does not introduce non-indexed meshes. Non-indexed procedural draws
remain the separate RenderDraw API.

CPU snapshots and detailed picking use views of only the selected vertices and indices, with local
index numbering. Bounds cover the selected vertex window, never the inactive source tail. An empty
index range has no bounds and is excluded from CPU ray picking. `pickWithRay` remains an AABB test,
not a triangle/point intersection test. Triangle-precise picking retains its triangle-only contract;
point/line materials can use AABB picking or caller predicates instead. Changing a range refreshes the CPU position-array identity,
marks caster bounds dirty, and invalidates main/depth/shadow render bundles without changing the
world transform. Repeating the same selection is a no-op. GPU picking, material geometry passes,
thin-instance direct draws and engine-managed indexed-indirect arguments use the same exact range.

The complete source arrays are retained independently of the selected CPU views, allowing regrowth
without re-uploading. Device-loss recovery restores the full initialized source and the selected range;
unused reserved capacity may collapse as with existing capacity updates. Cloning shares the selected
geometry and forbids subsequent range mutation until geometry is unshared. Geometry replacement
(`updateMeshGeometry`, capacity updates, or resize) clears the selection and restores that API's
existing full-geometry contract and invalidates commands that captured the selection.
`updateMeshGeometry` requires the complete initialized source lengths, not a selected snapshot;
capacity updates and resize can replace that complete source with different lengths.
GPU-only attribute writes do not refresh CPU geometry, as before.
Skeleton, morph and VAT meshes are rejected: their deformation/picking buffers have a separate
vertex-addressing contract.

Example (one initial upload, exact subsequent submissions):

```ts
const mesh = createMeshFromData(engine, "card", positions, normals, indices);
setMeshDrawRange(engine, mesh, { vertices: { offset: 0, count: 3 }, indices: { offset: 0, count: 3 } });
setMeshDrawRange(engine, mesh, { vertices: { offset: 0, count: 4 }, indices: { offset: 0, count: 6 } });
setMeshDrawRange(engine, mesh, { vertices: { offset: 0, count: 0 }, indices: { offset: 0, count: 0 } });
```

Legacy `updateMeshGeometryCapacity` callers retain their padded triangle-list behavior unless they
explicitly select an exact range afterward. Range selection is bounded by initialized CPU source
lengths, not merely spare allocation: uninitialized reservation tails cannot be made visible.

```ts
export function updateMeshGeometry(
    engine: EngineContext,
    mesh: Mesh,
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    uvs?: Float32Array,
    uvs2?: Float32Array,
    tangents?: Float32Array,
    colors?: Float32Array
): void;

export interface MeshGeometryCapacityResult {
    readonly stable: boolean;
    readonly vertexCapacity: number;
    readonly indexCapacity: number;
}

export function updateMeshGeometryCapacity(
    engine: EngineContext,
    mesh: Mesh,
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    uvs?: Float32Array,
    uvs2?: Float32Array,
    tangents?: Float32Array,
    colors?: Float32Array,
    reserveFactor?: number
): MeshGeometryCapacityResult;

export function resizeSharedMeshGeometry(
    engine: EngineContext,
    meshes: readonly Mesh[],
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    uvs?: Float32Array,
    uvs2?: Float32Array,
    tangents?: Float32Array,
    colors?: Float32Array
): void;
```

`resizeSharedMeshGeometry` requires a nonempty, dense list of distinct, live meshes sharing
one owned, tightly-packed GPU geometry. It rejects duplicate, disposed, missing, or
different-geometry entries before allocating buffers or changing reference counts.
The list may select only part of a clone family; omitted owners keep the old allocation.

The existing single-attribute update helpers also accept optional source/destination vertex ranges:

```ts
export function updateMeshPositions(engine: EngineContext, mesh: Mesh, values: Float32Array, vertexOffset?: number, vertexCount?: number, sourceVertexOffset?: number): void;
export function updateMeshNormals(engine: EngineContext, mesh: Mesh, values: Float32Array, vertexOffset?: number, vertexCount?: number, sourceVertexOffset?: number): void;
export function updateMeshColors(engine: EngineContext, mesh: Mesh, values: Float32Array, vertexOffset?: number, vertexCount?: number, sourceVertexOffset?: number): void;
export function updateMeshUvs(engine: EngineContext, mesh: Mesh, values: Float32Array, vertexOffset?: number, vertexCount?: number, sourceVertexOffset?: number): void;
export function updateMeshUv2(engine: EngineContext, mesh: Mesh, values: Float32Array, vertexOffset?: number, vertexCount?: number, sourceVertexOffset?: number): void;
export function updateMeshTangents(engine: EngineContext, mesh: Mesh, values: Float32Array, vertexOffset?: number, vertexCount?: number, sourceVertexOffset?: number): void;
```

These helpers pass the original `ArrayBuffer` plus byte offset/length directly to `GPUQueue.writeBuffer`;
they never allocate a `subarray`. Invalid tightly-packed ranges throw before any GPU or shadow state changes,
and an empty valid range is a no-op.

The mesh must originate from `createMeshFromData` or a factory using the same tight buffer layout.
The replacement arrays must have the same lengths and optional-attribute presence as the current
geometry. Interleaved loader geometry and shared clone geometry are rejected. Use
`resizeMeshGeometry` when any count/layout differs.

`updateMeshGeometryCapacity` accepts changing vertex/index counts on non-instanced meshes but not changing optional-attribute
presence. Indices must describe a triangle list (a multiple of three). `reserveFactor` defaults to `1.25`
and must be finite and at least `1`. On first use, the current
buffer lengths are the minimum capacity. Growth rounds each required capacity upward by the factor; shrinkage
never reallocates. The result reports whether this call kept the current buffers and the active capacities.
Empty optional arrays remain absent rather than enabling a new vertex attribute during growth.

## Internal Architecture

`updateMeshGeometry` validates all input before issuing a write. It then writes the existing position,
normal, index, UV, UV2, tangent, and color buffers with `GPUQueue.writeBuffer`. It does not allocate,
replace, retire, or expose any GPU resource.

After GPU writes, the mesh's retained CPU arrays are replaced, its AABB is recomputed from the new
positions, and the device-loss recovery capture receives the new optional arrays and index data.
GPU thin-instance culling observes the replacement CPU/bounds references and refreshes its local
culling sphere without replacing draw buffers. Geometry writes bump only the owning mesh's internal
world version, so cached ESM, PCF, and CSM shadow maps redraw only when one of their actual casters
changes, without replacing render bundles unless a complete update clears an explicit draw selection.
Geometry mutation and draw-range selection reject clone-shared geometry because one
mesh cannot invalidate every sibling that aliases the same GPU buffers.

The capacity path stores internal vertex/index capacities plus one reusable padded index array on `MeshGPU`.
A growth allocates padded typed arrays and copies the active values. An in-capacity update writes active attribute
prefixes plus the complete padded index array after zeroing its inactive tail. Main, shadow, picking, and
thin-instance paths keep their ordinary direct draw commands; the reserved tail consists only of degenerate
triangles. Retained Mesh CPU arrays always remain the exact active arrays, never the padded reservations.

Without an explicit draw selection, device-loss recovery rebuilds from those exact retained arrays and collapses any reservation. The next
capacity update re-establishes grow-only capacity if the active geometry later exceeds the recovered buffers.

`setMeshDrawRange` retains the complete initialized source arrays in internal `MeshGPU._drawRangeSource`,
independently of the selected CPU views. This state also owns the mutable active index count. The
existing public `MeshGPU.indexCount` remains readonly: the enabler installs a getter over that count,
falling back to the original reserved count when a complete geometry update clears the selection.
Ordinary geometry retains its original numeric count property and does not install the accessor.
First-index and base-vertex offsets are stored separately from physical buffer capacities.

Selection validates both ranges, WebGPU limits, ownership, deformation, every uploaded optional attribute's
retained presence/full-source length, and every selected index before
changing state. It creates attribute/index subarray views, recomputes bounds from selected positions,
marks the owning mesh's world revision dirty, and invalidates cached bundles without GPU writes or allocation.
An empty index range has no AABB and cannot be ray-picked. CPU snapshots copy the selected views;
precise picking visits only selected triangles. Geometry retains UV2 and color source arrays when supplied,
so every uploaded optional attribute can be selected and recovered.
The creation capture seam receives the original optional arrays; its existing implementation owns
normalization of absent attributes to `null`, rather than duplicating that work in the general factory.

Recovery uploads the complete initialized source, not the selected views, and restores active count and
offsets. It copies the selection state for independently rebuilt geometries so their counts do not alias.
Unused reservations may collapse to initialized source lengths; selections can still regrow within that source.
Complete updates and resize clear the explicit selection and return to their documented legacy draw behavior.

## Pipeline Configuration

Buffer identities, vertex layouts, index format, materials, pipelines, and bind groups
are unchanged while updates remain within capacity. Ordinary same-buffer geometry writes do not invalidate bundles.
A capacity growth replaces buffers once and invalidates bundles through the existing resize lifecycle.

An explicit draw selection changes draw arguments, not pipeline state. Direct indexed draws forward
`indexCount`, instance count, `firstIndex` (default zero), and `baseVertex` through regular and geometry
renderables for Standard, PBR, and Node materials, ShaderMaterial and its thin-instance path, GPU picking,
advanced picking, and debug-line draws. Geometry renderables also serve depth and shadow passes.
The indexed-indirect ABI is five uint32 words: index count, instance count, first index, signed base vertex,
and first instance. Cached thin-instance, GPU-culling, and LOD arguments refresh when the count or either
offset changes. Bundle invalidation is required when a selection changes or a complete update clears it,
even if buffer identities and counts otherwise remain unchanged.

## Shader Logic

None. Shaders consume the same attributes at the same locations and formats.

## State Machine / Lifecycle

1. Create a tight procedural mesh with `createMeshFromData`.
2. Call `updateMeshGeometry` for same-layout edits.
3. Call `updateMeshGeometryCapacity` for repeated live topology changes with stable attribute presence.
4. Call `resizeMeshGeometry` for one-shot exact-size topology or optional-attribute layout changes.
5. Call `resizeSharedMeshGeometry` when every supplied clone must keep sharing one rebuilt allocation.
6. Storage-backed/interleaved/borrowed geometry rejects these tightly-packed mutation APIs; update its
   source `StorageBuffer` instead.
7. Subsequent picking and device-loss recovery observe the latest complete active geometry.
8. Optionally select initialized geometry with `setMeshDrawRange`, including zero and odd point-list counts.
   Further selections reuse the full retained source. Complete updates clear the selection; recovery preserves it.

Validation throws before mutation, so a failed call leaves CPU/GPU state unchanged.

## Babylon.js Equivalence Map

Geometry writes correspond to updating Babylon.js vertex/index buffers and refreshing bounding information.
Exact draw selection corresponds to choosing an indexed submesh window without changing buffer contents,
with explicit first-index and base-vertex offsets rather than padded or degenerate indices.

## Dependencies

- `EngineContext` for the internal GPU queue and optional device-loss capture.
- `Mesh` for existing opaque GPU buffers and retained CPU geometry.
- `computeAabb` for refreshed bounds.

## Test Specification

- Reject changed vertex or index counts in `updateMeshGeometry`.
- Reject optional-attribute presence/length changes.
- Reject interleaved or shared-clone geometry.
- Reject duplicate, disposed, or missing shared-resize owners before any upload or ownership change.
- Confirm a shared-resize subset leaves omitted clone owners on their original live allocation.
- Reject invalid capacity factors and changing optional-attribute presence on the capacity path.
- Confirm same-size updates keep every GPU buffer identity unchanged.
- Confirm shrink/growth within capacity keeps every GPU buffer identity and the GPU draw index capacity unchanged.
- Confirm shrink/growth zeroes the reserved index tail so direct draws produce only active triangles.
- Confirm capacity overflow grows once, reports `stable:false`, and reserves at least the requested factor.
- Confirm retained CPU arrays, AABB, picking, and device-loss recovery use the replacement data.
- Confirm GPU-culling and CSM bound caches refresh after a same-buffer geometry update.
- Confirm static shadow tasks redraw after the geometry revision changes.
- Confirm exact selections submit zero, three, six, and odd point counts with independent vertex/index offsets.
- Reject fractional, negative, non-finite, overflowing, and out-of-source ranges and out-of-window index values before mutation.
- Reject borrowed, disposed, interleaved, shared, non-uint32, deformed, or missing retained geometry.
- Reject missing or undersized retained UV, UV2, tangent, or color arrays before CPU/GPU state or bundle versions change.
- Confirm range changes do not allocate/upload GPU geometry and preserve buffer identity.
- Confirm selected CPU snapshots are independent copies, all optional attributes are selected, inactive triangles cannot be picked,
  selected vertex windows determine bounds, and empty index ranges have no bounds.
- Confirm no-op selections preserve bundle versions, while changed selections and complete-update resets invalidate bundles.
- Confirm direct material paths forward the active count and both offsets and indirect paths preserve the five-word ABI,
  including unchanged-count offset changes and legacy zero defaults.
- Confirm recovery uploads complete source data, preserves empty/nonempty selections, permits source regrowth,
  and isolates the state of independently recovered clones.
- Confirm the published count declaration remains readonly and the root draw-range API is additive.
- Verify actual native WebGPU submissions, bundle execution, stable resources, and absence of GPU validation errors
  for ShaderMaterial, Standard, and PBR.
- Existing visual parity remains unchanged because no render math or pipeline state changes.

## File Manifest

- `packages/babylon-lite/src/mesh/mesh-factories.ts`: implementation.
- `packages/babylon-lite/src/mesh/mesh.ts`: opaque count, offset, source, and capacity state.
- `packages/babylon-lite/src/mesh/mesh-draw-range-state.ts`: opt-in readonly count accessor.
- `packages/babylon-lite/src/mesh/get-mesh-geometry.ts`: independent active CPU snapshots.
- `packages/babylon-lite/src/mesh/mesh-indexed-indirect.ts`: indexed-indirect ABI.
- `packages/babylon-lite/src/mesh/thin-instance-gpu.ts`: cached indirect argument synchronization.
- `packages/babylon-lite/src/mesh/thin-instance-gpu-culling.ts`: GPU-culling and LOD argument synchronization.
- `packages/babylon-lite/src/mesh/thin-instance-cull-binding.ts`: direct culling fallback draws.
- `packages/babylon-lite/src/engine/recovery-rebuild.ts`: complete-source upload and selection recovery.
- `packages/babylon-lite/src/material/{standard,pbr,node}/*-renderable.ts`: regular and geometry draw arguments.
- `packages/babylon-lite/src/material/shader/{shader-renderable,shader-thin-instance}.ts`: ShaderMaterial draw arguments.
- `packages/babylon-lite/src/picking/{ray-pick,gpu-picker,picking-advanced-draw}.ts`: selected/empty picking semantics.
- `packages/babylon-lite/src/physics/physics-debug-line-material.ts`: debug-line draw arguments.
- `packages/babylon-lite/src/index.ts`: public export.
- `tests/lite/unit/{mesh-draw-range,base-vertex-draw-paths,shader-vb-module-isolation}.test.ts`: range and direct-path contracts.
- `tests/lite/unit/mesh-geometry-update.test.ts`: unchanged legacy update/capacity behavior.
- `tests/lite/unit/get-mesh-geometry.test.ts`: CPU snapshot and optional-attribute behavior.
- `tests/lite/unit/{thin-instance-gpu,thin-instance-gpu-culling}.test.ts`: indirect/culling offset synchronization.
- `tests/lite/build/public-api-types.test.ts`: readonly public declarations and root exports.
- `tests/lite/plumbing/mesh-draw-range.spec.ts`: native WebGPU count, offset, resource, and bundle conformance.
- `lab/lite/{mesh-draw-range-test.html,src/mesh-draw-range-test.ts}`: generic card/point conformance fixture.
- `docs/lite/architecture/48-mesh-geometry-access.md`: selected CPU snapshot contract.
