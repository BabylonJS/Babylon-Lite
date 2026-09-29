# Task 4.4: Render Coarse PBR Batches Indirectly

## Goal

Render CPU-selected pinned clusters through a PBR-owned storage-fetch vertex variant and one indirect draw per batch.

## Requirements addressed

REQ-RENDER-1, REQ-RENDER-2, REQ-RENDER-3, REQ-SEL-7

## Background

Task 4.3 supplies CPU-selected cluster/instance pairs. The generic renderer must see an ordinary opaque `Renderable`; all MeshLoD pipeline, shader, bind-group, texture, and debug decisions live under `material/pbr`.

## Files to modify/create

- `packages/babylon-lite/src/material/pbr/pbr-mesh-lod-renderable.ts`
- `packages/babylon-lite/src/material/pbr/pbr-mesh-lod-compose.ts`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-scene.ts`
- `tests/lite/integration/mesh-lod/mesh-lod-coarse-render.test.ts`

## APIs and structs involved

- `Renderable`, `DrawBinding`, `DrawUpdateBatch`.
- Material group 1 bindings 0–15 from architecture section 13.3.
- 16-byte draw-vertex records and 16-byte `drawIndirect` args.

## Implementation details

1. Dynamically import the PBR MeshLoD module from the scene/runtime path.
2. Validate supported PBR fields and detect base/normal/ORM/emissive/double-sided/unlit variants.
3. CPU-expand selected local indices into draw-vertex records referencing the geometry arena; upload one indirect vertex count.
4. Compose a vertex path that unpacks position, oct normal, half UV and instance matrices while reusing supported PBR fragment behavior.
5. Bind fixed fallback textures for absent guaranteed channels.
6. Draw with `pass.drawIndirect(args,0)`, no vertex/index buffers, and return zero/one draw counts.

## Targeted tests

- Coarse-only statue fixture renders with fine streaming disabled.
- Draw-call instrumentation stays one per material/hierarchy batch as meshlet count changes.
- Supported material variants and unsupported-state rejection.

## Gotchas

- Do not put WGSL or pipeline creation in `mesh-lod-scene.ts`.
- Alpha is opaque in v1; do not approximate unsupported features.

## Dependencies

- Tasks 4.2–4.3.

## Verification checklist

- [ ] Complete coarse geometry renders before fine pages.
- [ ] Submission is not one draw per meshlet.
- [ ] Pipeline/BGL/WGSL ownership remains in PBR.
- [ ] Coarse rendering tests pass.
