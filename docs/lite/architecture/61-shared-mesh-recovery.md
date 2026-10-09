# Module: Shared Mesh Recovery

> Package path: `packages/babylon-lite/src/mesh/shared-mesh-recovery.ts`

## Purpose

Reconstruct one shared geometry allocation per replacement device, preserving
one reference claim per recovered mesh identity. Both glTF sharing and leased
detached meshes use this helper. See [device recovery](50-device-lost-recovery.md)
and [mesh retention](60-mesh-retention.md).

## Public API Surface

None. The internal standalone signature is:

```typescript
export function installSharedMeshRecovery(gpu: MeshGPU): void;
```

It is not exported from the package root. The glTF module preserves its existing
internal `_installSharedRecovery` alias for current callers/tests.

## Internal Architecture

Installation is idempotent: if `gpu._recoverShared` already exists, leave it
unchanged. Otherwise attach a recovery callback whose initially empty closure
holds the last replacement device, rebuilt MeshGPU, and a WeakSet of mesh
identities already credited with ownership on that device.

The callback receives the engine, live mesh identity, and the normal geometry
upload function. There are no module-level allocations or cross-engine global
caches. The rebuilt GPU object carries the same callback for subsequent losses.
The weak owner set records claims without strongly retaining mesh objects.

## Pipeline Configuration

No render pipeline, bind group, scene membership, or material output is built
here. The caller supplies the normal geometry uploader, which determines buffer
layout, index format, and any storage-backed geometry behavior. Recovery callers
rebuild bindings/pipelines separately on the replacement device.

## Shader Logic

None. CPU geometry is uploaded through the existing upload path without changing
vertex/index values, shader interpretation, transforms, or draw order.

## State Machine / Lifecycle

1. Initial installation records no replacement device or rebuilt allocation.
2. On a new device, call `upload(engine, mesh)` exactly once. Only after upload
   succeeds, commit the new device/allocation and initialize owners with this mesh.
   That upload's initial reference is the first owner's claim.
3. On the same device with a new mesh identity, add it to owners and `retain` the
   rebuilt allocation exactly once, then return that allocation.
4. On the same device with an already recovered identity, return the allocation
   without increasing its reference count.
5. On a later replacement device, repeat step 2; the old-device cache is replaced.

Upload errors propagate and do not commit a partially rebuilt cache. Normal
mesh disposal releases each recovered owner's claim; the final claim destroys
the allocation. Leases and scene memberships do not manufacture extra geometry
claims. Recovery callers skip disposed meshes and use a seen-identity set across
retained meshes and all registered scenes, so one identity is never counted twice
merely because it belongs to multiple scenes or is also leased.

This callback is invoked only for valid live owners during recovery, not as a
general API to revive a disposed allocation. Untracked, unleased loose meshes
retain their existing caller-owned recovery responsibility.

## Babylon.js Equivalence Map

Models shared geometry ownership across device replacement without changing the
mesh identity. It is an internal Lite resource-recovery detail, not a new
Babylon-style scene API or a clone/disposal implementation.

## Dependencies

- `mesh.ts`: internal Mesh/MeshGPU types and the `_recoverShared` callback contract.
- `resource/ref-count.ts`: one additional reference for each distinct recovered owner.
- `loader-gltf/gltf-share.ts`: installs sharing recovery when glTF geometry is shared.
- `engine/recovery-rebuild.ts`: uploads retained/attached geometry and deduplicates
  identities across scenes.
- `mesh-dispose.ts`: existing release/destroy lifecycle for geometry claims.

## Test Specification

- `device-lost-geometry-sharing.test.ts`: shared geometry rebuilt once and reused,
  with distinct owners receiving the correct reference count.
- `mesh-retention.test.ts`: a detached retained mesh and its clone recover into
  one replacement allocation; scene/lease multiplicity does not add sharing claims.
- `mesh-clone-gpu-dispose.test.ts`: independent clone disposal and final destruction.
- `device-lost-recovery.test.ts`: surrounding replacement-device sequencing and errors.
- `mesh-retention.spec.ts`: actual native device loss while detached, restoration
  of render pixels and GPU picking after reinsertion, and final resource release.

## File Manifest

- `packages/babylon-lite/src/mesh/shared-mesh-recovery.ts`
- `packages/babylon-lite/src/mesh/mesh.ts`
- `packages/babylon-lite/src/mesh/mesh-dispose.ts`
- `packages/babylon-lite/src/resource/ref-count.ts`
- `packages/babylon-lite/src/loader-gltf/gltf-share.ts`
- `packages/babylon-lite/src/engine/recovery-rebuild.ts`
- `tests/lite/unit/device-lost-geometry-sharing.test.ts`
- `tests/lite/unit/mesh-clone-gpu-dispose.test.ts`
- `tests/lite/unit/mesh-retention.test.ts`
- `tests/lite/unit/device-lost-recovery.test.ts`
- `tests/lite/plumbing/mesh-retention.spec.ts`
