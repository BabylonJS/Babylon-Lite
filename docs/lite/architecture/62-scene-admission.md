# Module: Opt-In Scene Admission

> Package path: `packages/babylon-lite/src/scene/scene-admission.ts`

## Purpose

Install and remove an engine-local admission policy without importing optional
feature code into ordinary scene consumers. [Mesh retention](60-mesh-retention.md)
uses the policy to make reinsertion idempotent while preserving legacy admission
on engines with no leases.

## Public API Surface

None. Both the installer and engine state field are internal and trimmed from
public declarations:

```typescript
export function installSceneAdmission(engine: EngineContext, policy: EngineContext["_admitSceneEntity"]): void;
// Internal EngineContext state:
_admitSceneEntity?: (scene: SceneContext, entity: object) => boolean;
```

There is no global callback, package-root export, or public controller method.

## Internal Architecture

The module imports only the engine type. Installing a defined policy assigns it
to that engine; installing `undefined` deletes the field. Importing the module
does nothing and allocates no caches. It is reached only from the optional
retention enabler/teardown.

Ordinary `addToScene` contains one optional-chained engine seam call before its
existing category dispatch. Only an explicit `false` skips the entity's own
insertion/build work; descendant traversal and parent linking still run. An absent
hook leaves the existing path unchanged. It has no static admission-module
import and no retention-specific condition or ownership lookup.

Retention installs the policy after recording the first successful mesh claim.
The feature callback treats physical mesh/light duplicate admission as a no-op:
mesh membership uses the existing external registry's scene set; light membership
uses that scene's light array. Disposed meshes deliberately continue to normal
registration, which throws rather than silently accepting a duplicate.
Other supported categories retain ordinary dispatch and hierarchy recursion.
An attached parent still admits detached or newly added descendants in normal
depth-first order, without duplicating existing siblings. Shared descendants
retain the source traversal's last-parent-link semantics; membership remains
independent per scene. Cyclic inputs retain the source parent-setter failure,
not a silently truncated traversal or a new graph-repair contract.

Policies are stored independently on each engine. Enabling or releasing ownership
on one engine never installs, replaces, or clears another engine's field. Callback
arguments are transient; no mesh or light acquires a stored scene reference.

## Pipeline Configuration

No pipeline or binding is created. Skipping duplicate own insertion avoids
unnecessary parent array/group changes. Missing descendant admission uses normal
membership/cache invalidation. A fresh mesh admission follows
normal group, build, shadow, and render-order machinery.

## Shader Logic

None. The policy changes membership admission, not pixels, visibility, material
flags, vertex/index ranges, camera transforms, or shader code.

## State Machine / Lifecycle

1. An ordinary engine starts with no admission field.
2. Successful explicit mesh retention installs an engine-local callback.
3. While any mesh leases remain on that engine, repeated mesh/light admission is
   idempotent, including children left attached by mesh-only detach.
4. Final lease removal for the engine deletes its field immediately, before
   fenced geometry retirement; default owning/admission behavior resumes.
5. A subsequent lease reinstalls the field. Engine teardown also clears it
   through retained-resource revocation.

The engine's mesh identity set may remain empty for reuse by its managed disposer;
an empty set is not an installed feature callback. No stale module-global policy
can affect an unopted engine.

## Babylon.js Equivalence Map

Normal scene add semantics remain the familiar membership operation. The
idempotent policy is an explicit Lite engine capability accompanying leases,
not a new default behavior for all scenes or a mesh-attached method.

## Dependencies

- `engine.ts`: internal optional state-field type.
- `mesh-retention.ts`: owns policy meaning, activation, and final cleanup.
- `mesh-scene-registry.ts`: feature callback's constant-time mesh membership.
- `scene-core.ts`: invokes the optional field without importing this module.

## Test Specification

- `mesh-retention.test.ts`: independent engines, no hook/legacy duplicates before
  opt-in, hook installation, engine-local final cleanup, duplicate reinsertion,
  preserved child light membership, disposed/cross-engine admission errors.
- `remove-from-scene.test.ts`: legacy owning removal remains intact.
- `scene-retained-admission.test.ts`: duplicate mesh/light parents, detached and
  fresh descendants, nested transforms, camera roots, containers, shared nodes,
  multiple scenes, geometry claims, and source cyclic-input failure.
- `public-api-types.test.ts`: internal hook/installer absent from public declarations.
- `mesh-retention.spec.ts`: real reinsertion order, merged-group output bounds,
  picking exclusion, and geometry reuse.
- `scene-retained-admission.spec.ts`: native hierarchy reinsertion, CPU/GPU picking,
  transparent tie pixels versus fresh admission, and stable geometry allocation.
- Scoped runtime bundle measurement: ordinary scenes retain unchanged ceilings;
  inspect emitted modules to ensure the optional installer/retention code is not
  fetched by unopted scenes. Never alter ceilings or published baselines to hide cost.

## File Manifest

- `packages/babylon-lite/src/scene/scene-admission.ts`
- `packages/babylon-lite/src/scene/scene-core.ts`
- `packages/babylon-lite/src/engine/engine.ts`
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
