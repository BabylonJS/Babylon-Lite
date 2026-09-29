# Task 4.3: Add Lazy Scene Registry and CPU Selection

## Goal

Create plain MeshLoD instances, scene-owned batching, idempotent add/remove, and per-frame CPU-oracle selection.

## Requirements addressed

REQ-INT-3, REQ-INT-4, REQ-INT-7, REQ-SEL-7

## Background

Task 4.2 creates scene-independent ready assets. Follow `scene-core.ts:282-300`: optional systems add deferred renderables through their own API rather than teaching `addToScene` about a feature.

## Files to modify/create

- `packages/babylon-lite/src/mesh-lod/mesh-lod-scene.ts`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.ts`
- `packages/babylon-lite/src/scene/scene-core.ts` — optional `_meshLoDRegistry`.
- `tests/lite/unit/mesh-lod/mesh-lod-scene.test.ts`

## APIs and structs involved

- `createMeshLoDInstance`, `addMeshLoDToScene`, `removeMeshLoDFromScene`.
- `MeshLoDSceneRegistry`, `MeshLoDSceneBatch`, `MeshLoDInstance extends SceneNode`.

## Implementation details

1. Build instances from `createSceneNode`, alias public/internal asset/material fields, and allocate stable IDs lazily.
2. Validate the guaranteed opaque PBR subset immediately.
3. Store registries only on `SceneContext`; assets/instances never reference a scene.
4. Batch by exact asset and material identity; retain independent transforms/visibility/SSE.
5. Register one deferred builder per scene registry and avoid duplicate registrations.
6. Update instance matrices/version state and invoke CPU selection per batch.
7. Make add/remove idempotent and remove instances from future submission immediately.

## Targeted tests

- Two transformed instances share one asset.
- Same instance add/remove repetition.
- Two scenes share an asset without cross-scene references.
- Unsupported material returns `MLOD_UNSUPPORTED_MATERIAL`.

## Gotchas

- Do not add MeshLoD to `addToScene`'s union or branches.
- Exact material object identity is part of the batch key.

## Dependencies

- Tasks 3.4 and 4.2.

## Verification checklist

- [ ] Object graph has one-way scene ownership.
- [ ] Shared-instance transforms select independently.
- [ ] Remove takes effect before the next selection.
- [ ] Scene registry tests pass.
