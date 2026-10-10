# Module: Mesh Resource Retention

> Package path: `packages/babylon-lite/src/mesh/mesh-retention.ts`

## Purpose

Give a caller explicit ownership of a physical mesh across zero-scene lifetimes.
Detachment removes scene rendering and picking membership without destroying
geometry or changing identity, visibility, parenting, or children. Default
owning removal remains unchanged without a lease. See [scene membership](01-scene.md).

## Public API Surface

```typescript
export interface MeshResourceLease {
    readonly mesh: Mesh;
}
export function retainMeshResources(engine: EngineContext, mesh: Mesh): MeshResourceLease;
export function releaseMeshResources(lease: MeshResourceLease): void;
export function detachMeshFromScene(scene: SceneContext, mesh: Mesh): void;
```

All three functions and the lease type are exported from the package root.
The frozen lease is an identity token, not a controller with attached methods.
Release the exact issued object; copied or forged tokens throw. Releasing an
issued, already released or engine-revoked token is a no-op.

Retain before last-scene removal. Detach requires an active lease for the scene's
engine and accepts only physical meshes, not transform nodes, containers, lights,
cameras, or contributor entities. It does not recursively detach children.
Reinsert with `addToScene`; caller-owned picking snapshots are not rewritten.

## Internal Architecture

Lazy module weak collections hold mesh-to-retention, lease-to-retention, issued
tokens, disposed feature engines, and meshes currently enumerating textures.
No collection is allocated at import time. Each retention contains its mesh,
engine, a set of independent active leases, and a GPU-texture-to-Texture2D map.
The engine's internal `_retainedMeshes` set strongly owns leased mesh identities
even when no scene owns them.

The existing external mesh-scene registry owns scene subscriptions; mesh data
does not reference scenes. Its opt-in hooks validate engine ownership and capture
material texture claims on admission and reassignment. Retention observes the
material setter before first admission as well as while detached.

The lease pins the mesh's existing geometry resource claim. It never increments
`MeshGPU._refCount`: multiple scenes and multiple leases are not geometry-sharing
owners. Clone/shared-geometry counts and unique-update guards retain their meaning.

Texture capture enumerates source-material textures, enabled plugin textures,
and nested shadow-caster materials, visiting each material once. Enumeration is
transactional before acquiring additional claims. Deduplication is by allocation
identity; previously captured textures remain owned until final release. After
recovery replaces facade handles, the map is re-keyed before acquisition.
Reentrant enumeration, retention, or release during capture throws explicitly.

## Pipeline Configuration

This module creates no pipelines, shader modules, or bind groups. Detach reuses
the scene-removal machinery: evict all mesh slots, standalone renderables,
material-group outputs, queued swaps/builds, and task bindings; preserve parenting.
Actual mutations invalidate scene renderable versions. A repeated detach does not.

Reinsertion builds ordinary fresh scene-local renderables and appends normal
admission order. Explicit render order still takes precedence over stable depth
ties. Scene-local uniforms, bindings, and wrappers may allocate again; the
reuse guarantee concerns owned geometry, not all GPU or JavaScript allocations.
An awaited group rebuild reconciles surviving members' current admission order
before publication. Detach/reinsert races retry within the existing bounded rebuild
transaction, so the first settled frame does not wait for a queued follow-up.
Repeated parent admission skips only already-present membership/build work:
descendants are still traversed, so detached or newly added children are admitted.

## Shader Logic

No WGSL or pixel math is added. Existing material/shadow pipelines consume the
same geometry and transforms. Visibility remains caller state independent of
membership. CPU scene picking enumerates current meshes; GPU picking rejects
removed readback identities and restarts all lazy preparation when membership
changes before encoding, including advanced draw closures.
Preparation is bounded to 16 attempts: continued scene/device churn rejects the
request explicitly without poisoning the serialized queue. Picker disposal during
preparation produces an empty result and does not recreate its targets.

## State Machine / Lifecycle

1. Validate a live physical mesh and compatible owning engine.
2. First retain captures textures, registers engine teardown, tracks the mesh,
   installs [per-engine admission](62-scene-admission.md), and observes material.
3. Every retain issues a frozen token and adds it to the mesh's lease set.
4. Detach captures current textures, evicts only the requested scene membership,
   and leaves geometry alive across retirement fences and zero attached scenes.
5. Release removes one token. Other leases or scene owners preserve resources.
6. Final release removes the retention and engine mesh entry, clears the admission
   hook when that engine has no remaining leased meshes, and schedules fenced
   teardown. The callback rechecks all current scene/retention ownership before
   disposing geometry, then releases the captured texture claims.
7. Engine teardown revokes tokens, marks the feature engine disposed, clears its
   admission hook, and force-disposes retained resource claims. Scene teardown
   alone does not revoke leases. Explicit `disposeMeshGpu` remains force-disposal.

Recovery rebuilds retained identities before registered scenes using one seen
set, preserving detached buffers on the replacement device and avoiding duplicate
identity rebuilds. Shared allocation replacement uses
[shared mesh recovery](61-shared-mesh-recovery.md). Replacement-device allocation
is expected and is not part of the detach/reinsert allocation-reuse measurement.
Recovery rechecks disposal after loading shared recovery support, before installing
or uploading a replacement. A lease retired during that await cannot acquire a
phantom replacement ownership claim.

Forgotten leases remain explicit ownership until engine teardown. Independently
owned storage/render-target/external/cube resources, producer controllers, and
animation ownership retain their own contracts.

## Babylon.js Equivalence Map

The familiar scene add/remove membership concept is separated from disposal
through a Lite-specific explicit lease. Hiding is not detaching: an invisible
mesh still belongs to a scene and can remain CPU-pickable. No source-engine
implementation or asset is copied.

## Dependencies

- `mesh-dispose`, `gpu-resource-retirement`: shared-claim release and fenced work.
- `mesh-scene-registry`, `scene-remove`, `scene-admission`: ownership, observation,
  membership eviction, and opt-in admission policy installation.
- `managed-resource-hooks`: engine-owned final cleanup.
- `material-textures`, `material-view`, `texture-references`: texture enumeration
  and independent allocation claims.
- `recovery-rebuild`, `shared-mesh-recovery`: replacement-device reconstruction.
- `gpu-picker`: membership-stable asynchronous picking.

## Test Specification

- `mesh-retention.test.ts`: 1,000 fenced cycles, mesh-only parenting/visibility,
  multiple scenes/leases, clones/refcounts, unique/shared updates, duplicate slots,
  engine/scene teardown, queued-release reacquisition, cross-engine errors,
  detached recovery, material/texture swaps, reentrancy, and independent engine hooks.
- `retained-shared-recovery-import.test.ts`: controlled import pause, last-lease
  retirement during recovery, and exactly-once destruction of surviving replacement buffers.
- `gpu-picker-membership.test.ts`: controlled preparation pause, retirement,
  fresh identity/order, filter selection, disposal cancellation, and queue recovery.
- `gpu-picker-retry.test.ts`: bounded unstable retries and subsequent queue use.
- `scene-retained-admission.test.ts` and `scene-retained-admission.spec.ts`:
  duplicate parents still admit missing descendants, preserve source parent
  links and per-scene ownership, and reuse geometry with fresh rendering/picking.
- `mesh-retention.spec.ts`: native public rendering, CPU/GPU picking, 1,000 complete
  activations, transparent tie reference, geometry-count stability, final disposal,
  device loss, and network-controlled advanced preparation with actual buffer binding.
  Also compares the first settled PBR transparent frame to fresh admission while
  the queued follow-up remains blocked.
- `public-api-types.test.ts`: pure-state lease, supported roots, readonly public
  declarations, and absence of internal retention/admission helpers.

No fixture requires external game assets. No zero-total-allocation or FPS claim
is inferred from geometry reuse.

## File Manifest

- `packages/babylon-lite/src/mesh/mesh-retention.ts`
- `packages/babylon-lite/src/scene/mesh-scene-registry.ts`
- `packages/babylon-lite/src/scene/scene-remove.ts`
- `packages/babylon-lite/src/scene/scene-admission.ts`
- `packages/babylon-lite/src/engine/engine.ts`
- `packages/babylon-lite/src/engine/recovery-rebuild.ts`
- `packages/babylon-lite/src/picking/gpu-picker.ts`
- `tests/lite/unit/mesh-retention.test.ts`
- `tests/lite/unit/gpu-picker-membership.test.ts`
- `tests/lite/unit/gpu-picker-retry.test.ts`
- `tests/lite/unit/scene-retained-admission.test.ts`
- `tests/lite/plumbing/scene-retained-admission.spec.ts`
- `lab/lite/scene-retained-admission-test.html`
- `lab/lite/src/scene-retained-admission-test.ts`
- `tests/lite/build/public-api-types.test.ts`
- `tests/lite/plumbing/mesh-retention.spec.ts`
- `lab/lite/mesh-retention-test.html`
- `lab/lite/src/mesh-retention-test.ts`
