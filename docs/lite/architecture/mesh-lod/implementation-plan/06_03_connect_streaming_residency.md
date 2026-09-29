# Task 6.3: Connect Demand, Streaming, and Residency

## Goal

Wire GPU/CPU demand to scheduler, decode/upload, selection residency, diagnostics, and public runtime controls.

## Requirements addressed

REQ-LOAD-2, REQ-SEL-3, REQ-SEL-6, REQ-SEL-7, REQ-STREAM-1..6

## Background

Tasks 6.1–6.2 provide scheduler/cache components. This task completes the frame loop from demand readback to atomic group refinement.

## Files to modify/create

- `packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.ts`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-scene.ts`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.ts`
- `packages/babylon-lite/src/mesh-lod/mesh-lod.ts`
- `tests/lite/integration/mesh-lod/mesh-lod-streaming.test.ts`

## APIs and structs involved

- `setMeshLoDScreenSpaceError`, `setMeshLoDCacheBudget`, `setMeshLoDStreamingPaused`.
- Page state machine from `unrequested` through `gpu-resident`/failure/eviction.

## Implementation details

1. Read page-demand words asynchronously without stalling the current coarse draw.
2. Feed generation-stamped demands to scheduler and update queued/in-flight diagnostics.
3. Validate fetched page CRC/header, decode, allocate, upload, and commit residency in order.
4. Update group residency only when every referenced page is GPU resident.
5. Ensure the next selection atomically replaces coarser clusters; partial groups never appear.
6. Apply cache-budget changes, pause, threshold changes, terminal errors, bytes, and unmet-SSE diagnostics.
7. Retain nearest resident ancestor for delayed/cancelled/retried/failed/evicted fine data.

## Targeted tests

- Group split across pages switches only after last upload.
- Pause/resume, budget reduction, failed page, stale completion, camera movement cancellation.
- Diagnostics state/byte counters.

## Gotchas

- Readback latency must not remove the last valid selection.
- A fine terminal failure is page-local, not an asset bootstrap failure.

## Dependencies

- Tasks 5.2, 6.1, and 6.2.

## Verification checklist

- [ ] Fine pages progressively improve output.
- [ ] Partial residency never creates mixed cuts.
- [ ] Public controls take effect and remain observable.
- [ ] Coarse fallback remains complete.
