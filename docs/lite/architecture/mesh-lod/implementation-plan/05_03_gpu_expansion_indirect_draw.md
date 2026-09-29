# Task 5.3: Expand Clusters and Issue Indirect Draws

## Goal

GPU-expand selected indexed triangles into the storage-backed draw stream and publish one indirect PBR draw per batch.

## Requirements addressed

REQ-RENDER-1, REQ-RENDER-2, REQ-RENDER-3, REQ-RENDER-4

## Background

Task 5.2 produces selected cluster/instance pairs. Task 4.4 already owns the PBR storage-fetch pipeline; replace CPU expansion with compute while retaining the same material path.

## Files to modify/create

- `packages/babylon-lite/src/mesh-lod/mesh-lod-selection.wgsl`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.ts`
- `packages/babylon-lite/src/material/pbr/pbr-mesh-lod-renderable.ts`
- `packages/babylon-lite/src/material/pbr/pbr-mesh-lod-compose.ts`
- `tests/lite/integration/mesh-lod/mesh-lod-indirect-render.test.ts`

## APIs and structs involved

- Compute indirect args 12 bytes.
- Draw vertices 16 bytes: arena word offset, cluster ID, instance ID, debug/group flags.
- Draw indirect args 16 bytes.

## Implementation details

1. Convert selected count into `dispatchWorkgroupsIndirect`.
2. Run one workgroup per selected cluster; reserve `triangleCount * 3` draw vertices atomically.
3. Read packed `u16` local indices and write absolute arena vertex-word offsets plus IDs.
4. Finalize `drawIndirect.vertexCount` and diagnostics.
5. Update PBR binding to consume current buffers at draw time and call exactly one `drawIndirect`.
6. Grow transient buffers make-before-break; retain last valid coarse result on overflow.

## Targeted tests

- Exact expanded records for a tiny fixture.
- Vary selected meshlet count while draw calls remain one.
- Buffer growth and zero-selection draw behavior.
- PBR/unlit/double-sided supported variants.

## Gotchas

- No vertex/index buffer may be bound.
- Debug flags must not affect selection or residency.

## Dependencies

- Tasks 4.4 and 5.2.

## Verification checklist

- [ ] Expanded vertices reference correct page/cluster/instance data.
- [ ] One compatible batch produces at most one draw.
- [ ] Zero selected vertices produce zero draws.
- [ ] Resource replacement is frame-safe.
