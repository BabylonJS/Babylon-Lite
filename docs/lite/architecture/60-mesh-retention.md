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
Task bindings include explicit render-task admissions still queued for their first
recording, so a later recording cannot restore the detached draw. Shadow generators'
nested caster tasks never see scene removal, so detach also records the mesh as
detached from that scene: the caster set each shadow dispatcher reads for the scene
omits it (a stable filtered array, so the task rebuilds once and the map re-renders),
without mutating the caller's array. Reinsertion restores the original array; a mesh
retired while detached stays excluded while a caller's array still holds it.
Exclusions are weak per mesh and scene, so they never keep a released mesh alive.
The per-frame lookup is non-allocating while unchanged: it scans the caller's array
against the cached filtered array and rebuilds only when the effective set changes.
When the caller's array no longer needs filtering, its cached filtered result is
dropped so former survivors are not kept reachable by the cache.
Actual mutations invalidate scene renderable versions. A repeated detach does not.
Detaching the last member of a material group before the scene is first registered
leaves that group's boot-time builder queued; the builder cancels an empty group
instead of building it, so a later reinsertion creates a fresh group that the boot
drain or the runtime build path materializes.
Scene core builds boot and device-lost recovery groups through an optional
group-build runner seam. Scenes that never remove or detach a mesh leave it
unassigned, so the bundler folds it away and the builder reads the live group, as
before: no member can leave while it awaits. The first `removeFromScene` or
retention lease installs `buildGroupSnapshot` (in `scene-remove`), which hands the
builder a snapshot of the group's members, so a detach or removal while the
builder awaits a lazy import cannot change the list it iterates. After the build
it confirms an unchanged group by a single linear comparison of the snapshot with
the live group. Only when membership changed does it load the lazy
`scene-group-settle` chunk, which reconciles the build against the group's
current sequence using constant-time membership lookups:

- Output for a snapshot member that left meanwhile is evicted before it is
  committed (its renderables are dropped and its per-mesh teardown retires after
  GPU submission), and a mesh that joined meanwhile is queued for the
  material-swap drain, so it is built exactly once.
- The build is obsolete and is retried against the current sequence when the
  surviving members changed relative order (a detach and reinsertion, which
  changes transparent tie order), or when a member left and the build either
  merged it into a renderable without a mesh back-reference or threw. A throw is
  how a builder fails on a member detached, re-materialed into another family and
  reinserted while it awaited; that mesh is built by its current family's group.
  A failure that persists without a membership change is rethrown.
- Per-mesh resources of an obsolete build retire only after the replacement build.
  A group that empties is cancelled like an emptied boot group. A group whose
  membership keeps changing for three attempts is abandoned and its members are
  queued for the material-swap drain, which builds a group without a completed
  build through the runtime path.

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
preparation produces an empty result and does not recreate its targets; requests
already queued when it is disposed resolve empty too. Requests capture an explicit
disposal generation at enqueue, which automatic device replacement does not bump.

## State Machine / Lifecycle

1. Validate a live physical mesh and compatible owning engine.
2. First retain captures textures, registers engine teardown, tracks the mesh,
   installs [lease-gated admission](62-scene-admission.md), the snapshot group-build
   runner, and the leased texture-ownership settle seam, and observes material.
3. Every retain issues a frozen token and adds it to the mesh's lease set.
4. Detach captures current textures, evicts only the requested scene membership,
   and leaves geometry alive across retirement fences and zero attached scenes.
   It publishes one `removed` event for that mesh to `onSceneChange` subscribers;
   reinsertion through `addToScene` publishes `added`, and admission-rejected
   descendants that never left publish nothing. A subscription made while a mesh is
   detached seeds mesh membership from `scene.meshes`, not hierarchy reachability,
   so the detached mesh's later reinsertion still publishes `added`.
5. Release removes one token. Other leases or scene owners preserve resources.
6. Final release removes the retention and engine mesh entry (an engine with no
   remaining leased meshes reverts to legacy admission), and schedules fenced
   teardown. The callback rechecks all current scene/retention ownership before
   disposing geometry, then releases the captured texture claims. Device recovery
   queues a texture's pending ownership top-up before its rebuild's first await,
   keyed by both the wrapper and the outgoing handle, so the window covers an
   in-flight url fetch before the handle is replaced or adopted. While that top-up
   is pending, retention
   keeps that pending total equal to the claims still owed from before the loss
   plus the claims currently live. A claim acquired in that window is live and
   also raises the total, so settlement keeps it instead of absorbing it into the
   pre-loss count. A released claim lowers the total and drops a live claim only
   when nothing is still owed. Otherwise, releasing the replacement would destroy a
   texture that surviving leases and its creator still own. A total released to
   zero with no live claim retires the replacement at settlement instead of
   leaking it. A texture with no owner at the loss (a mipmapped glTF texture
   before its meshes first bind) is queued too, so claims taken during its rebuild
   are carried; the entry records whether the texture was ever owned, so a
   never-owned texture keeps its replacement while one released back to zero retires it.
7. Engine teardown revokes tokens, marks the feature engine disposed, empties its
   leased-mesh set (restoring legacy admission), and force-disposes retained resource claims. Scene teardown
   alone does not revoke leases. Explicit `disposeMeshGpu` remains force-disposal.

Recovery rebuilds retained identities before registered scenes using one seen
set, preserving detached buffers on the replacement device and avoiding duplicate
identity rebuilds. The set also records each allocation recovery rebuilt, so a mesh
cloned from an already recovered mesh while recovery awaits — including a uniquely
owned source that never received a shared-recovery hook — keeps its claim on that
live replacement instead of being uploaded again. Shared allocation replacement uses
[shared mesh recovery](61-shared-mesh-recovery.md). Replacement-device allocation
is expected and is not part of the detach/reinsert allocation-reuse measurement.
Recovery rechecks disposal after loading shared recovery support, before installing
or uploading a replacement. A lease retired during that await cannot acquire a
phantom replacement ownership claim.
Meshes with opt-in mesh-local draw-range source windows recover independently,
even when a clone initially shares their allocation. Reusing a replacement handle
would couple mutable active selections; ordinary shared geometry still recovers once.
Skeleton and morph-target objects shared by a detached source and its attached clone
are rebuilt once per recovery through the same seen set, so the replacement handles
stay under their existing owner counts. A registered scene whose material group was
emptied by detach drops that group and its runtime base instead of invoking the
builder; reinsertion builds a fresh group.

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
- `mesh-scene-registry`, `scene-remove`, `scene-group-settle`: ownership,
  observation, membership eviction, snapshot group builds, and their lazy settlement.
- `scene-core`: zero-cost admission and group-build runner seams.
- `texture-ownership-settle`: zero-cost seam through which retention retires a
  replacement texture whose leased claims were all released during recovery.
- `managed-resource-hooks`: engine-owned final cleanup.
- `material-textures`, `material-view`, `texture-references`: texture enumeration
  and independent allocation claims.
- `recovery-rebuild`, `shared-mesh-recovery`: replacement-device reconstruction.
- `gpu-picker`: membership-stable asynchronous picking.

## Test Specification

- `mesh-retention.test.ts`: 1,000 fenced cycles, mesh-only parenting/visibility,
  multiple scenes/leases, clones/refcounts, unique/shared updates, duplicate slots,
  engine/scene teardown, queued-release reacquisition, cross-engine errors,
  detached recovery, independent mesh-local draw selection recovery, dropping a
  queued explicit render-task admission, shadow-caster exclusion until reinsertion,
  collection of repeatedly retired distinct detached meshes, non-allocating unchanged
  caster lookups,
  material/texture swaps, reentrancy, independent engine hooks, and scene-change
  events for detach/reinsertion without echoing retained children.
- `retained-shared-recovery-import.test.ts`: controlled import pause, last-lease
  retirement during recovery, and exactly-once destruction of surviving replacement buffers.
- `retained-shared-recovery-retirement.test.ts`: releasing one of two shared-texture
  leases after texture replacement but before ownership settles keeps the survivor's
  texture live, and its final teardown destroys it exactly once. A clone retained
  after replacement keeps its own claim through settlement and pre-loss release;
  releasing it before settlement neither debits pre-loss owners nor leaks once every
  owed claim has been re-acquired. With a controlled url fetch paused before handle
  replacement, a lease acquired mid-fetch survives the creator's and the pre-loss
  lease's release; a fenced release mid-fetch is not restored at settlement; and
  releasing the last lease claim mid-fetch retires the replacement. Each final
  teardown destroys the replacement exactly once. With a controlled mipmap import
  paused in a zero-owner bitmap rebuild, two leases taken mid-rebuild are both
  restored, the survivor stays live, and final teardown destroys it once; a
  never-owned texture keeps its replacement. A registered scene emptied by detach
  skips its PBR-style group builder, and deformation shared by a detached source
  and attached clone is uploaded once and torn down once.
- `gpu-picker-membership.test.ts`: controlled preparation pause, retirement,
  fresh identity/order, filter selection, disposal cancellation of preparing and
  queued picks, and queue recovery.
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
- `packages/babylon-lite/src/scene/scene-group-settle.ts`
- `packages/babylon-lite/src/scene/scene-core.ts`
- `packages/babylon-lite/src/engine/engine.ts`
- `packages/babylon-lite/src/engine/recovery-rebuild.ts`
- `packages/babylon-lite/src/texture/texture-recovery.ts`
- `packages/babylon-lite/src/texture/texture-ownership-settle.ts`
- `packages/babylon-lite/src/frame-graph/shadow-inputs.ts`
- `packages/babylon-lite/src/frame-graph/render-task-base.ts`
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
