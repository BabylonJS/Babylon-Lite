# Module: Opt-In Scene Admission

> Package path: `packages/babylon-lite/src/scene/scene-core.ts` (seam);
> `packages/babylon-lite/src/mesh/mesh-retention.ts` (policy)

## Purpose

Let an optional feature veto an entity's own insertion without importing that
feature into ordinary scene consumers. [Mesh retention](60-mesh-retention.md)
uses the seam to make reinsertion idempotent on engines with live leases while
preserving legacy admission everywhere else.

## Public API Surface

None. The seam and its installer are internal and trimmed from public
declarations:

```typescript
/** @internal */
export function _installSceneAdmission(policy: (scene: SceneContext, entity: SceneEntity) => boolean): void;
```

There is no package-root export, engine state field, or public controller method.

## Internal Architecture

`scene-core.ts` holds a module-level `let _sceneAdmission` and its installer.
`addToScene` makes one optional call, `_sceneAdmission?.(ctx, entity) !== false`,
before its existing category dispatch. Only an explicit `false` skips the
entity's own insertion/build work; descendant traversal and parent linking still
run. When the installer is not bundled the binding is never assigned, so the
bundler folds the call away: unopted scenes pay zero bytes and no runtime check.

Retention installs `admitRetained` on the first successful mesh claim. The
policy is global but gated per engine: it returns `true` (legacy admission)
whenever the scene's engine has no live leases (`_retainedMeshes?.size` is 0).
On an engine with leases it treats physical mesh/light duplicate admission as a
no-op: mesh membership uses the external registry's scene set; light membership
uses that scene's light array. Disposed meshes deliberately continue to normal
registration, which throws rather than silently accepting a duplicate. Other
supported categories retain ordinary dispatch and hierarchy recursion. An
attached parent still admits detached or newly added descendants in normal
depth-first order, without duplicating existing siblings. Shared descendants
retain the source traversal's last-parent-link semantics; membership remains
independent per scene. Cyclic inputs retain the source parent-setter failure,
not a silently truncated traversal or a new graph-repair contract.

Callback arguments are transient; no mesh or light acquires a stored scene
reference.

## Pipeline Configuration

No pipeline or binding is created. Skipping duplicate own insertion avoids
unnecessary parent array/group changes. Missing descendant admission uses normal
membership/cache invalidation. A fresh mesh admission follows normal group,
build, shadow, and render-order machinery.

## Shader Logic

None. The policy changes membership admission, not pixels, visibility, material
flags, vertex/index ranges, camera transforms, or shader code.

## State Machine / Lifecycle

1. Before any lease is taken the seam is unassigned; admission is unchanged.
2. The first successful mesh retention installs the policy (idempotently).
3. While an engine has leased meshes, repeated mesh/light admission on its scenes
   is idempotent, including children left attached by mesh-only detach.
4. When an engine's final lease is released, or the engine is torn down, its
   `_retainedMeshes` set empties and the policy falls back to legacy admission
   for that engine immediately.
5. Engines never share lease state: leases on one engine never change admission
   on another.

## Babylon.js Equivalence Map

Normal scene add semantics remain the familiar membership operation. The
idempotent policy is an explicit Lite capability accompanying leases, not a new
default behavior for all scenes or a mesh-attached method.

## Dependencies

- `scene-core.ts`: owns the seam and invokes it from `addToScene`.
- `mesh-retention.ts`: owns policy meaning and installation.
- `mesh-scene-registry.ts`: policy's constant-time mesh membership.

## Test Specification

- `mesh-retention.test.ts`: duplicate admission enforced only on engines with live
  leases, legacy admission restored after the final lease, independent engines,
  duplicate reinsertion, preserved child light membership, disposed/cross-engine
  admission errors.
- `remove-from-scene.test.ts`: legacy owning removal remains intact.
- `scene-retained-admission.test.ts`: duplicate mesh/light parents, detached and
  fresh descendants, nested transforms, camera roots, containers, shared nodes,
  multiple scenes, geometry claims, and source cyclic-input failure.
- `public-api-types.test.ts`: internal installer absent from public declarations.
- `mesh-retention.spec.ts`: real reinsertion order, merged-group output bounds,
  picking exclusion, and geometry reuse.
- `scene-retained-admission.spec.ts`: native hierarchy reinsertion, CPU/GPU picking,
  transparent tie pixels versus fresh admission, and stable geometry allocation.
- Scoped runtime bundle measurement: ordinary scenes retain unchanged ceilings;
  the seam must fold away when retention is not bundled. Never alter ceilings or
  published baselines to hide cost.

## File Manifest

- `packages/babylon-lite/src/scene/scene-core.ts`
- `packages/babylon-lite/src/mesh/mesh-retention.ts`
- `packages/babylon-lite/src/scene/mesh-scene-registry.ts`
- `tests/lite/unit/mesh-retention.test.ts`
- `tests/lite/unit/remove-from-scene.test.ts`
- `tests/lite/unit/scene-retained-admission.test.ts`
- `tests/lite/build/public-api-types.test.ts`
- `tests/lite/plumbing/mesh-retention.spec.ts`
- `tests/lite/plumbing/scene-retained-admission.spec.ts`
- `lab/lite/scene-retained-admission-test.html`
- `lab/lite/src/scene-retained-admission-test.ts`
