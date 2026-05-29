# Task 2.1: Scene precision policy resolver

> **⚠ SUPERSEDED by commit `07be57e` (engine-at-construction simplification).**
> This task originally introduced `ScenePrecisionPolicy` + `resolveScenePrecisionPolicy`
> as a per-scene captured policy object. After the simplification, entities take
> `engine` directly at construction and allocate caches from
> `engine._matrixPolicy.allocator` immediately — no per-scene policy object is
> needed. The `_scene-precision.ts` module has been deleted; floating-origin
> offset is wired onto the active `scene.camera._floatingOriginOffset` field in
> the scene's `_update`. See `GUIDANCE.md` pillar 4b″.
>
> Kept as historical record of the original M0 design.

## Goal

Add the `ScenePrecisionPolicy` shape on `SceneContextInternal`, populated by an internal `resolveScenePrecisionPolicy(engine, options)` function called inside `createSceneContext`. M0 returns the engine's policy unmodified; the structural seam exists so M1 can later assert that `useFloatingOrigin: true` requires engine high-precision mode without restructuring the call sites. After this task, scenes carry a stable per-scene policy reference that subsequent tasks will use to bind entity matrix storage.

## Requirements addressed

REQ-INT-2, REQ-ARCH-1, REQ-ARCH-4.

## Background

Babylon Lite scenes are created by `createSceneContext(engine, options?)` in `packages/babylon-lite/src/scene/scene-core.ts:152`. The function returns a public `SceneContext` whose internal shape `SceneContextInternal` (defined at line ~76) extends `SceneContext` with rendering state. The function already initializes a few options-driven fields that match this pattern: `_floatingOriginMode`, `_eyePosition`, `_floatingOriginOffset` (lines 182–184).

Task 1.3 added `_matrixPolicy: MatrixAllocator` to `EngineContextInternal` in `packages/babylon-lite/src/engine/engine.ts`. The `MatrixAllocator` interface lives at `packages/babylon-lite/src/math/_matrix-allocator.ts`:

```ts
interface MatrixAllocator { storageKind: "f32" | "f64"; allocate(): Mat4 }
```

The architecture (D6) defines the M0 scene-side contract:

```ts
function resolveScenePrecisionPolicy(engine: EngineContextInternal, sceneOptions: SceneContextOptions): ScenePrecisionPolicy;
interface ScenePrecisionPolicy {
    readonly useHighPrecisionMatrix: boolean;
    readonly storageKind: "f32" | "f64";
    /** @internal Allocator inherited from engine. */
    readonly allocator: MatrixAllocator;
}
```

For M0 the function is a pure mirror of the engine policy. The `useFloatingOrigin` validation guard described in D6 lands in M1 — DO NOT add it now.

## Files to modify / create

- `packages/babylon-lite/src/scene/_scene-precision.ts` — **NEW**. Internal-only module exporting `ScenePrecisionPolicy` and `resolveScenePrecisionPolicy`.
- `packages/babylon-lite/src/scene/scene-core.ts` —
    - Add `_matrixPolicy: ScenePrecisionPolicy` to the `SceneContextInternal` interface (next to `_floatingOriginMode` / `_eyePosition` / `_floatingOriginOffset`).
    - In `createSceneContext`, call `resolveScenePrecisionPolicy(eng, options)` and assign the result to `_matrixPolicy` on the scene context literal.

## Implementation details

1. Create `packages/babylon-lite/src/scene/_scene-precision.ts`:

   ```ts
   import type { EngineContextInternal } from "../engine/engine.js";
   import type { MatrixAllocator } from "../math/_matrix-allocator.js";
   import type { SceneContextOptions } from "./scene-core.js";

   /** @internal Per-scene captured matrix policy. */
   export interface ScenePrecisionPolicy {
       readonly useHighPrecisionMatrix: boolean;
       readonly storageKind: "f32" | "f64";
       readonly allocator: MatrixAllocator;
   }

   /** @internal Resolve and freeze a scene's matrix policy from the owning engine.
    *  In M0 this mirrors the engine policy; M1 will extend it to enforce
    *  useFloatingOrigin → useHighPrecisionMatrix coupling. */
   export function resolveScenePrecisionPolicy(
       engine: EngineContextInternal,
       _sceneOptions: SceneContextOptions,
   ): ScenePrecisionPolicy {
       const allocator = engine._matrixPolicy;
       return {
           useHighPrecisionMatrix: allocator.storageKind === "f64",
           storageKind: allocator.storageKind,
           allocator,
       };
   }
   ```

   The leading `_` in the filename marks the module internal. NOT re-exported from `index.ts`.

2. In `packages/babylon-lite/src/scene/scene-core.ts`:

   - Add at the top, after the existing `import type { ... }` block:

     ```ts
     import { resolveScenePrecisionPolicy, type ScenePrecisionPolicy } from "./_scene-precision.js";
     ```

   - In the `SceneContextInternal` interface, add the field next to `_floatingOriginMode`:

     ```ts
     /** @internal Captured matrix-precision policy for this scene. */
     _matrixPolicy: ScenePrecisionPolicy;
     ```

   - In `createSceneContext` (line 152), immediately after the `eyePosition` / `floatingOriginOffset` declarations and before the `ctxLocal` literal, compute:

     ```ts
     const matrixPolicy = resolveScenePrecisionPolicy(eng, options);
     ```

   - Inside the `ctxLocal` object literal (currently around line 158–185), add `_matrixPolicy: matrixPolicy,` next to `_floatingOriginMode:` (line 182).

3. Verify the module is not re-exported: `Select-String -Path .\packages\babylon-lite\src\index.ts -Pattern '_scene-precision'` returns no matches.

## Testing suggestions

- `pnpm exec tsc --noEmit` — clean.
- Add a unit test `tests/unit/scene-matrix-policy.test.ts`:
    - Engine created with `useHighPrecisionMatrix: false` → `(scene as SceneContextInternal)._matrixPolicy.storageKind === "f32"` and `.useHighPrecisionMatrix === false`.
    - Engine created with `useHighPrecisionMatrix: true` → `"f64"` / `true`.
    - Two scenes on the same engine share the same allocator reference (`scene1._matrixPolicy.allocator === scene2._matrixPolicy.allocator`) — captured policy is consistent within an engine.
    - Scenes on **different** engines do NOT share allocator references — confirms per-engine isolation (REQ-ARCH-1).
- `pnpm exec vitest run` — green.
- `pnpm test:parity` — green (no rendered output should change yet; this is plumbing only).

## Gotchas

- Do NOT mutate the public `SceneContextOptions` interface. The engine-wide `useHighPrecisionMatrix` flag stays on `EngineOptions` only; `SceneContextOptions` already has `useFloatingOrigin?: boolean` and that's the only public per-scene flag related to LWR.
- The `_matrixPolicy` field is on `SceneContextInternal` only — it must not leak through the public `SceneContext` interface. Verify by searching for any new `_matrixPolicy` reference in `SceneContext` (the public interface starts around line 40).
- Freeze considerations: do NOT call `Object.freeze` on the policy. The shape uses `readonly` in TypeScript which is sufficient; runtime freezing has measurable allocation overhead and is not the codebase convention.
- The M1 `useFloatingOrigin → useHighPrecisionMatrix` validation MUST NOT be implemented here. Adding it now would block any current test that creates a floating-origin scene without HPM, and is explicitly out of M0 scope per `requirements.md` REQ-INT-2.

## Verification checklist

- [ ] `packages/babylon-lite/src/scene/_scene-precision.ts` exists with `ScenePrecisionPolicy` and `resolveScenePrecisionPolicy`.
- [ ] `SceneContextInternal._matrixPolicy: ScenePrecisionPolicy` is declared.
- [ ] `createSceneContext` populates `_matrixPolicy` from `resolveScenePrecisionPolicy(eng, options)`.
- [ ] Unit test `tests/unit/scene-matrix-policy.test.ts` covers HPM-on/off + per-engine isolation.
- [ ] Public `SceneContext` interface is unchanged.
- [ ] `_scene-precision.ts` is NOT re-exported from `packages/babylon-lite/src/index.ts`.
- [ ] `pnpm exec vitest run`, `pnpm test:parity` are green.
