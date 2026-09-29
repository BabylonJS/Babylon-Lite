# Task 7.2: Add Generic Deferred Device Recovery

## Goal

Add a generic scene-owned recoverable-deferred-renderable seam and use it to restore MeshLoD coarse rendering after device loss.

## Requirements addressed

REQ-LOAD-4, REQ-RENDER-4, REQ-INT-2

## Background

`device-lost-recovery.ts:238-261` currently clears renderables and rebuilds ordinary material groups only. MeshLoD must recover without a feature-specific branch.

## Files to modify/create

- `packages/babylon-lite/src/scene/scene-core.ts` — `_deferredGpuRecoverables` and `DeferredSceneGpuRecoverable`.
- `packages/babylon-lite/src/engine/device-lost-recovery.ts` — iterate generic recoverables after ordinary groups.
- `packages/babylon-lite/src/mesh-lod/mesh-lod-scene.ts`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.ts`
- `packages/babylon-lite/src/material/pbr/pbr-mesh-lod-renderable.ts`
- `tests/lite/integration/mesh-lod/mesh-lod-device-recovery.test.ts`

## APIs and structs involved

- Internal `DeferredSceneGpuRecoverable.rebuild(engine,scene)` and `dispose()`.
- Asset state `recovering`, retained encoded pages, deterministic refetch.

## Implementation details

1. Add the optional list to `SceneContext`; initialize it only when a feature registers.
2. During recovery rebuild ordinary meshes/groups, then invoke generic recoverables and append their renderables before sorting/frame-graph build.
3. Mark assets recovering and invalidate device-keyed pipelines/bind groups.
4. Recreate metadata/page state/arena/transient buffers, decode/upload retained pinned pages, and rebuild PBR packets.
5. Report recovery success only after coarse rendering is restored.
6. Re-upload retained fine pages, then refetch missing prior residents; fine failures remain page-local.
7. Map terminal coarse failure to `MLOD_DEVICE_RECOVERY`.

## Targeted tests

- Forced device loss with retained pinned/fine bytes.
- Deterministic refetch when CPU cache lacks a prior resident.
- Coarse failure prevents success callback.
- Existing ordinary recovery tests remain green.

## Gotchas

- Old resources on a truly lost device need no queue retirement.
- The recovery module must contain no MeshLoD import/branch.

## Dependencies

- Task 7.1 and existing device recovery.

## Verification checklist

- [ ] Generic seam rebuilds optional renderables.
- [ ] Recovery resumes with complete coarse geometry.
- [ ] Fine residency is restored opportunistically.
- [ ] No core MeshLoD branch exists.
