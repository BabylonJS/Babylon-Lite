# Task 7.1: Implement Disposal and Scene Pruning

## Goal

Make asset disposal idempotent, generation-safe, scene-aware, and compatible with shared assets/instances.

## Requirements addressed

REQ-LOAD-3, REQ-INT-4, REQ-INT-7, REQ-RENDER-4

## Background

Phase 6 adds queued/in-flight work and CPU/GPU caches. Disposal must stop future mutation immediately while submitted GPU work retires safely.

## Files to modify/create

- `packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.ts`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-scene.ts`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-cache.ts`
- `tests/lite/unit/mesh-lod/mesh-lod-disposal.test.ts`
- `tests/lite/integration/mesh-lod/mesh-lod-shared-lifecycle.test.ts`

## APIs and structs involved

- `disposeMeshLoDAsset`, `removeMeshLoDFromScene`.
- Asset/page generations, abort controllers, scene registry pruning, frame references.

## Implementation details

1. On first disposal set state `disposed`, increment generation, abort asset/page controllers, and clear queued/retry work.
2. Reject stale fetch/decode/upload/readback completions before mutation.
3. Mark scene batches non-drawable immediately; prune disposed assets before next encoding.
4. Retire GPU buffers only after frame safety and release CPU bytes/metadata after scene registries drop references.
5. Keep scene disposal limited to its registrations; it must not dispose an asset used by another scene.
6. Make repeated dispose/remove calls no-ops with stable diagnostics/error behavior.

## Targeted tests

- Dispose during fetch/decode/upload/readback.
- Repeated disposal.
- One of two instances/scenes removed while the other continues.
- Accounting returns to shared baseline after final owner.

## Gotchas

- Do not write scene references into assets to simplify cleanup.
- A completion racing abort must never make a page resident.

## Dependencies

- Phase 6.

## Verification checklist

- [ ] Disposed assets never mutate or draw.
- [ ] Shared live instances remain valid.
- [ ] Resources retire after submitted work.
- [ ] Lifecycle tests pass.
