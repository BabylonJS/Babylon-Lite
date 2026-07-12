# Module: In-place Mesh Geometry Update
> Package path: `packages/babylon-lite/src/mesh/mesh-factories.ts`

## Purpose

Update every attribute and the index data of an existing tightly-packed procedural mesh while its
vertex/index counts and attribute layout remain unchanged. GPU buffer identities stay stable, so
cached render and shadow bundles remain valid. CPU geometry, bounds, detailed picking, and
device-loss recovery are updated atomically with the GPU contents.

Topology growth or shrinkage may use either `resizeMeshGeometry`, which replaces exact-size buffers and
invalidates cached bundles safely, or `updateMeshGeometryCapacity`, which reserves grow-only capacity and
keeps the inactive index tail degenerate so live procedural edits retain stable buffer identities and draw topology.

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

`updateMeshGeometryCapacity` accepts changing vertex/index counts on non-instanced meshes but not changing optional-attribute
presence. Indices must describe a triangle list (a multiple of three). `reserveFactor` defaults to `1.25`
and must be finite and at least `1`. On first use, the current
buffer lengths are the minimum capacity. Growth rounds each required capacity upward by the factor; shrinkage
never reallocates. The result reports whether this call kept the current buffers and the active capacities.
Empty optional arrays remain absent rather than enabling a new vertex attribute during growth.

## Internal Architecture

The function validates all input before issuing a write. It then writes the existing position,
normal, index, UV, UV2, tangent, and color buffers with `GPUQueue.writeBuffer`. It does not allocate,
replace, retire, or expose any GPU resource.

After GPU writes, the mesh's retained CPU arrays are replaced, its AABB is recomputed from the new
positions, and the device-loss recovery capture receives the new optional arrays and index data.
GPU thin-instance culling observes the replacement CPU/bounds references and refreshes its local
culling sphere without replacing draw buffers. Geometry writes bump only the owning mesh's internal
world version, so cached ESM, PCF, and CSM shadow maps redraw only when one of their actual casters
changes, without replacing render bundles. Range updates reject clone-shared geometry because one
mesh cannot invalidate every sibling that aliases the same GPU buffers.

The capacity path stores internal vertex/index capacities plus one reusable padded index array on `MeshGPU`.
A growth allocates padded typed arrays and copies the active values. An in-capacity update writes active attribute
prefixes plus the complete padded index array after zeroing its inactive tail. Main, shadow, picking, and
thin-instance paths keep their ordinary direct draw commands; the reserved tail consists only of degenerate
triangles. Retained Mesh CPU arrays always remain the exact active arrays, never the padded reservations.

Device-loss recovery rebuilds from those exact retained arrays and collapses any reservation. The next
capacity update re-establishes grow-only capacity if the active geometry later exceeds the recovered buffers.

## Pipeline Configuration

None. Buffer identities, vertex layouts, index format, materials, pipelines, bind groups, and direct draw commands
are unchanged while updates remain within capacity. Render-bundle invalidation is deliberately not performed.
A capacity growth replaces buffers once and invalidates bundles through the existing resize lifecycle.

## Shader Logic

None. Shaders consume the same attributes at the same locations and formats.

## State Machine / Lifecycle

1. Create a tight procedural mesh with `createMeshFromData`.
2. Call `updateMeshGeometry` for same-layout edits.
3. Call `updateMeshGeometryCapacity` for repeated live topology changes with stable attribute presence.
4. Call `resizeMeshGeometry` for one-shot exact-size topology or optional-attribute layout changes.
5. Subsequent picking and device-loss recovery observe the latest complete active geometry.

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
- Reject invalid capacity factors and changing optional-attribute presence on the capacity path.
- Confirm same-size updates keep every GPU buffer identity unchanged.
- Confirm shrink/growth within capacity keeps every GPU buffer identity and the GPU draw index capacity unchanged.
- Confirm shrink/growth zeroes the reserved index tail so direct draws produce only active triangles.
- Confirm capacity overflow grows once, reports `stable:false`, and reserves at least the requested factor.
- Confirm retained CPU arrays, AABB, picking, and device-loss recovery use the replacement data.
- Confirm GPU-culling and CSM bound caches refresh after a same-buffer geometry update.
- Confirm static shadow tasks redraw after the geometry revision changes.
- Existing visual parity remains unchanged because no render math or pipeline state changes.

## File Manifest

- `packages/babylon-lite/src/mesh/mesh-factories.ts`: implementation.
- `packages/babylon-lite/src/index.ts`: public export.
