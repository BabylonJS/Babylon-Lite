# Task 7.3: Verify Frame-Safe Lifecycle Recovery

## Goal

Prove disposal, eviction, buffer replacement, shared ownership, and device recovery cannot invalidate submitted work or coarse fallback.

## Requirements addressed

REQ-LOAD-3, REQ-LOAD-4, REQ-RENDER-4

## Background

Tasks 7.1–7.2 complete lifecycle behavior. Follow test patterns in `gpu-resource-retirement.test.ts:35-145` and `device-lost-geometry-sharing.test.ts:55-97`.

## Files to modify/create

- `tests/lite/integration/mesh-lod/mesh-lod-lifecycle.test.ts`
- `tests/lite/integration/mesh-lod/mesh-lod-device-recovery.test.ts`
- `tests/lite/unit/mesh-lod/mesh-lod-frame-refs.test.ts`
- `tests/lite/unit/device-lost-geometry-sharing.test.ts` — generic-seam regression assertions if needed.

## APIs and structs involved

- Page `frameRefCount`, `retireGpuResources`, deferred recoverables, asset generations.

## Implementation details

1. Hold submitted-work promises and assert referenced pages/buffers are not evicted/destroyed before completion.
2. Test make-before-break transient growth and normal device-preserving rebuilds.
3. Test disposal during every async state and repeated disposal.
4. Test two scenes/two instances sharing one asset and independent removal.
5. Force device loss, verify coarse-first success, fine restoration, and explicit coarse recovery failure.
6. Run targeted unit/integration suites and mandatory `pnpm test`; do not run performance tests.

## Targeted tests

- Named lifecycle/recovery files plus existing GPU retirement/device loss suites.
- Full `pnpm test`.

## Gotchas

- Do not treat queue submission as completed work.
- Recovery callbacks must not report success before pinned upload.

## Dependencies

- Tasks 7.1–7.2.

## Verification checklist

- [ ] Current-frame resources survive until fence completion.
- [ ] Shared owners are isolated.
- [ ] Recovery is coarse-first and explicit on failure.
- [ ] Mandatory `pnpm test` passes.
