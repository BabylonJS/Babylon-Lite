# Task 2.2: Bind matrix-owning state at attach; cross-engine fast-fail

> **⚠ SUPERSEDED by commit `07be57e` (engine-at-construction simplification).**
> This task originally introduced `bindEntityMatrixPolicy` /
> `_entity-precision-bind.ts` + per-entity `_boundPolicy` / `_rebindAllocator`
> machinery to defer matrix-storage decisions to attach time. After the
> simplification, entities take `engine` at construction so storage is
> allocated with the correct precision from the start — no bind step exists
> and the whole `_entity-precision-bind.ts` module has been deleted. The
> "cross-engine fast-fail" rule survives in spirit (entities can't be moved
> between engines because their matrix caches are committed at construction)
> but is no longer enforced by an explicit comparison.
>
> Kept as historical record of the original M0 design.

## Goal

When an entity (mesh, camera, light, shadow generator, transform node, asset container) is added to a scene, bind its matrix-owning caches to the scene's captured `_matrixPolicy`. Entities are created standalone (no scene argument) per `GUIDANCE.md` §4b, so binding happens at the first attachment. If an already-bound entity is attached to a scene whose engine has a *different* precision policy, throw a synchronous configuration error at the `addToScene` call site. Same-engine reattach is permitted and is a no-op.

## Requirements addressed

REQ-ARCH-1, REQ-ARCH-4, REQ-MAT-1, REQ-COMP-3.

## Background

Babylon Lite uses functional factories: `createMesh()`, `createArcRotateCamera()`, `createDirectionalLight()`, `createShadowGenerator()`, `createTransformNode()`, `loadGltf()` etc. all return fully-constructed entities without taking a scene argument. The user attaches the entity to a scene via `addToScene(scene, entity)` defined in `packages/babylon-lite/src/scene/scene-core.ts:291`.

Today `addToScene` handles three cases (line 294–349):
1. AssetContainer (loadGltf result) — `if ("entities" in entity)` recurses.
2. Mesh — `if ("_gpu" in entity && "material" in entity)` pushes to `ctx.meshes` and queues a deferred builder.
3. Light — `else if ("lightType" in entity)` pushes to `ctx.lights`.
Plus child recursion (line 343).

Task 2.1 added `_matrixPolicy: ScenePrecisionPolicy` to `SceneContextInternal`, which contains `{ useHighPrecisionMatrix, storageKind, allocator }`. The architecture (D2) prescribes this attach behavior:

- Entities start unbound.
- `addToScene` is the binding seam for mesh/camera/light/transform-node.
- `registerScene` runs deferred builders that bind loader-allocated scratch (covered in Task 2.4 for glTF).
- Same-engine reattach is permitted as a no-op (engine policy hasn't changed; entity storage is valid).
- Cross-engine reattach must throw synchronously.
- Device rebuild is irrelevant to CPU-side policy.

## Files to modify / create

- `packages/babylon-lite/src/scene/_entity-precision-bind.ts` — **NEW**. Internal helpers `bindEntityMatrixPolicy(entity, policy)` and `assertSamePrecisionPolicy(entity, policy)`. Encapsulates the per-entity-kind switch so `addToScene` stays readable.
- `packages/babylon-lite/src/scene/scene-core.ts` — In `addToScene`, call the bind/assert helper for every entity case (mesh, light, camera, shadow, transform node, asset container children). Add a tiny brand on entities — `_boundPolicy: ScenePrecisionPolicy | null` — written by the helper.
- `packages/babylon-lite/src/mesh/mesh.ts`, `packages/babylon-lite/src/camera/camera.ts`, `packages/babylon-lite/src/light/types.ts` (or wherever `LightBase` lives), `packages/babylon-lite/src/scene/transform-node.ts`, `packages/babylon-lite/src/shadow/shadow-generator.ts`, `packages/babylon-lite/src/scene/scene-node.ts` — Add `_boundPolicy?: ScenePrecisionPolicy | null` field to each entity's internal interface. Use the existing `*Internal` pattern if present, otherwise extend the public interface with a `@internal` JSDoc.

## Implementation details

1. Create `packages/babylon-lite/src/scene/_entity-precision-bind.ts`:

   ```ts
   import type { ScenePrecisionPolicy } from "./_scene-precision.js";

   /** @internal Anything that participates in matrix precision binding. */
   export interface MatrixBindable {
       _boundPolicy?: ScenePrecisionPolicy | null;
   }

   /** @internal Bind an entity to a scene's precision policy on first attach.
    *  If the entity is already bound to the same engine's policy (same allocator
    *  reference), this is a no-op. If bound to a different engine's policy,
    *  throw a configuration error. */
   export function bindEntityMatrixPolicy(entity: MatrixBindable, policy: ScenePrecisionPolicy): void {
       const prior = entity._boundPolicy;
       if (prior === undefined || prior === null) {
           entity._boundPolicy = policy;
           return;
       }
       if (prior.allocator === policy.allocator) {
           return;
       }
       throw new Error(
           "Babylon Lite: cannot attach a matrix-owning entity to a scene whose engine has a different matrix-precision policy. " +
           "Create a new entity for the second engine instead of reusing one.",
       );
   }
   ```

2. In `packages/babylon-lite/src/scene/scene-core.ts`, import the helper at the top:

   ```ts
   import { bindEntityMatrixPolicy } from "./_entity-precision-bind.js";
   ```

3. In `addToScene` (line 291), at the top of the function — after the `const ctx = scene as SceneContextInternal;` line — add:

   ```ts
   // AssetContainer case is handled below; everything else needs binding.
   if (!("entities" in entity)) {
       bindEntityMatrixPolicy(entity as unknown as { _boundPolicy?: ScenePrecisionPolicy | null }, ctx._matrixPolicy);
   }
   ```

   The asset-container branch (line 294) recurses into individual entities, so each child gets its own `bindEntityMatrixPolicy` call via the recursive `addToScene` (line 297).

4. Child recursion at line 343 already calls `addToScene` recursively, so children's policy binding happens automatically. Confirm this when you read the function.

5. Add `_boundPolicy?: ScenePrecisionPolicy | null` to the **internal** interface for each entity kind. Conventionally these live next to existing `_*` cache fields:
    - `Camera` interface in `packages/babylon-lite/src/camera/camera.ts` — add next to `_viewCache`.
    - `MeshInternal` in `packages/babylon-lite/src/mesh/mesh.ts` — add next to `_gpu`.
    - `LightBase` (or its internal extension) in `packages/babylon-lite/src/light/types.ts`.
    - `TransformNode` internal in `packages/babylon-lite/src/scene/transform-node.ts`.
    - `ShadowGenerator` internal in `packages/babylon-lite/src/shadow/shadow-generator.ts`.
    - `SceneNode` (parent class for child recursion) in `packages/babylon-lite/src/scene/scene-node.ts`.

   If the interface is split into public + internal, add the field on the **internal** form only. Use `@internal` JSDoc.

6. **Do not** allocate any matrix storage in this task. Caches still live in their existing `Float32Array(16)` initializers. Task 2.3 changes those allocations to flow through `_boundPolicy.allocator.allocate()`.

7. Same-engine reattach test: removing an entity from one scene (no public API today removes individual entities, only `disposeScene`) and re-adding it to another scene on the same engine MUST not throw. Confirm by writing the unit test in step 1 below.

## Testing suggestions

- New unit test `tests/unit/entity-precision-bind.test.ts`:
    - Create engine A (HPM off), scene A1, attach a mesh — `mesh._boundPolicy` references the engine A policy.
    - Attach the same mesh to scene A2 (also engine A) — no throw, `_boundPolicy` unchanged.
    - Create engine B (HPM on), scene B1, attempt to attach the same mesh — assert `addToScene` throws with a message containing "matrix-precision policy".
    - Cross-check with cameras, lights, transform nodes (one each).
- `pnpm exec vitest run` — green, including new test.
- `pnpm exec tsc --noEmit` — clean.
- `pnpm test:parity` — green (no rendered output change).
- Confirm existing scene unit tests in `tests/unit/` still pass (this is plumbing only).

## Gotchas

- The recursive `addToScene` at line 297 for asset containers must NOT double-bind; binding happens at the inner call. The outer asset-container branch is the one place where the top-level "if not entities, bind" guard above MUST remain. Trace the function flow before committing.
- `bindEntityMatrixPolicy` uses **reference equality on `policy.allocator`**, NOT on `policy` itself. Two scenes on the same engine share the same allocator instance (verified in Task 2.1's test) but have distinct `ScenePrecisionPolicy` objects.
- Do not throw on reattach to the **same scene** twice — the existing `addToScene` is not idempotent for `meshes.push`, but the bind check must be. Same-allocator reference makes the second call a no-op.
- When extending entity interfaces, do not place `_boundPolicy` on the public interface (e.g. `Camera`'s public side). Keep it `@internal`.
- The fast-fail message MUST mention "matrix-precision policy" (the audit in Task 4.1 may look for this exact substring; downstream tests assert it).
- This task does NOT change `disposeScene`. Detaching is not a public operation today; entities cannot be removed individually. If a future task adds detach, it should clear `_boundPolicy`. Out of M0 scope.

## Verification checklist

- [ ] `packages/babylon-lite/src/scene/_entity-precision-bind.ts` exists with `bindEntityMatrixPolicy`.
- [ ] `addToScene` calls `bindEntityMatrixPolicy` for every non-asset-container entity.
- [ ] Internal interfaces for `Camera`, `MeshInternal`, light base, `TransformNode`, `ShadowGenerator`, `SceneNode` declare `_boundPolicy?: ScenePrecisionPolicy | null`.
- [ ] Unit test `tests/unit/entity-precision-bind.test.ts` covers same-engine reattach (no-op) and cross-engine reattach (throws).
- [ ] Throw message contains the substring "matrix-precision policy".
- [ ] `pnpm exec vitest run`, `pnpm test:parity` are green.
