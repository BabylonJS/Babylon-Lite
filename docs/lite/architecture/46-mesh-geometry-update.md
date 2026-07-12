# Module: In-place Mesh Geometry Update
> Package path: `packages/babylon-lite/src/mesh/mesh-factories.ts`

## Purpose

Update every attribute and the index data of an existing tightly-packed procedural mesh while its
vertex/index counts and attribute layout remain unchanged. GPU buffer identities stay stable, so
cached render and shadow bundles remain valid. CPU geometry, bounds, detailed picking, and
device-loss recovery are updated atomically with the GPU contents.

Topology growth or shrinkage remains the responsibility of `resizeMeshGeometry`, which replaces
buffers and invalidates cached bundles safely.

## Public API Surface

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
```

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

## Internal Architecture

The function validates all input before issuing a write. It then writes the existing position,
normal, index, UV, UV2, tangent, and color buffers with `GPUQueue.writeBuffer`. It does not allocate,
replace, retire, or expose any GPU resource.

After GPU writes, the mesh's retained CPU arrays are replaced, its AABB is recomputed from the new
positions, and the device-loss recovery capture receives the new optional arrays and index data.
GPU thin-instance culling observes the replacement CPU/bounds references and refreshes its local
culling sphere without replacing draw buffers. CSM caster bounds include the shared shadow-caster
epoch in their cache key for the same reason.
The shared shadow-caster epoch also advances, causing cached ESM, PCF, and CSM shadow maps to redraw
without replacing their render bundles.

## Pipeline Configuration

None. Buffer identities, vertex layouts, index format, index count, materials, pipelines, bind
groups, and draw calls are unchanged. Render-bundle invalidation is deliberately not performed.

## Shader Logic

None. Shaders consume the same attributes at the same locations and formats.

## State Machine / Lifecycle

1. Create a tight procedural mesh with `createMeshFromData`.
2. Call `updateMeshGeometry` for same-layout edits.
3. Call `resizeMeshGeometry` when vertex/index counts or optional attributes change.
4. Subsequent picking and device-loss recovery observe the latest complete geometry.

Validation throws before mutation, so a failed call leaves CPU/GPU state unchanged.

## Babylon.js Equivalence Map

Equivalent in purpose to updating every updatable vertex/index buffer of a Babylon.js mesh while
refreshing bounding information, without changing the mesh or submesh draw topology.

## Dependencies

- `EngineContext` for the internal GPU queue and optional device-loss capture.
- `Mesh` for existing opaque GPU buffers and retained CPU geometry.
- `computeAabb` for refreshed bounds.

## Test Specification

- Reject changed vertex or index counts.
- Reject optional-attribute presence/length changes.
- Reject interleaved or shared-clone geometry.
- Confirm same-size updates keep every GPU buffer identity unchanged.
- Confirm retained CPU arrays, AABB, picking, and device-loss recovery use the replacement data.
- Confirm GPU-culling and CSM bound caches refresh after a same-buffer geometry update.
- Confirm static shadow tasks redraw after the geometry revision changes.
- Existing visual parity remains unchanged because no render math or pipeline state changes.

## File Manifest

- `packages/babylon-lite/src/mesh/mesh-factories.ts`: implementation.
- `packages/babylon-lite/src/index.ts`: public export.
