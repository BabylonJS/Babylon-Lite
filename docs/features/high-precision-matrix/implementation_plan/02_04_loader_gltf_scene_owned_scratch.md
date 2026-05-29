> **SUPERSEDED.** This task delivered the per-loadGltf LoaderScratch factory and parameter-threading. It was reverted to module-level lazy-init scratch ( _loader-scratch.ts getters) once the matrix allocator became a process-global lazy singleton. See GUIDANCE pillar 4b'' (single matrix precision per page).

---

# Task 2.4: glTF loader — replace module-local scratch with scene-owned scratch

## Goal

Move the precision-bearing scratch matrices in the glTF loader from module-local lazy state to scene/loader-owned scratch allocated through the scene's matrix allocator. The remaining scratch in `gltf-parser.ts`, `gltf-animation.ts`, and `gltf-feature-gpu-instancing.ts` MUST come from the policy of the engine that called `loadGltf`. After this task, two engines on the same page running glTF loads with different precision policies do not share scratch state.

## Requirements addressed

REQ-MAT-2, REQ-ARCH-1, REQ-ARCH-2, REQ-ARCH-3.

## Background

`loadGltf(engine, url)` (search `packages/babylon-lite/src/loader-gltf/` for the entry point) returns an `AssetContainer` of entities + animation groups + materials. During parsing it composes node TRS into a world matrix and during animation evaluation it composes per-bone scratch.

The scratch sites today (from the architecture's "Requirement concerns" note and grep evidence):

- `packages/babylon-lite/src/loader-gltf/gltf-parser.ts:152` — `const world = new Float32Array(16) as Mat4` inside the parse function (per-call).
- `packages/babylon-lite/src/loader-gltf/gltf-parser.ts:164` — `_localScratch = new Float32Array(16);` — module-local lazy. **This is the site that violates REQ-ARCH-3 today** (module-level state means two engines share it).
- `packages/babylon-lite/src/loader-gltf/gltf-animation.ts:95` — `const tmp = new Float32Array(16);` inside the per-keyframe sample loop (per-call). Allocates on every call but is not module state.
- `packages/babylon-lite/src/loader-gltf/gltf-feature-gpu-instancing.ts:158` — `const instWorld = new Float32Array(16) as Mat4` inside the per-instance loop.

For M0:

- The `gltf-parser.ts` line 164 module-local `_localScratch` MUST become loader-owned (per-`loadGltf`-call) scratch derived from the engine policy. This is the only true fix mandated by `REQ-ARCH-3`.
- The other three sites are per-call locals and don't violate isolation. However, REQ-MAT-2 requires that *outputs* feed precision-preserving storage. Per-call F32 scratch that immediately writes back into a policy-allocated world cache is acceptable because the F32 scratch is a local with values <1e6 (composed from local TRS), but if the world matrix composition involves multiplying a parent world (potentially F64) into a child, that scratch's intermediates DO need to be F64 when HPM is on.

The simplest correct policy is: **all glTF mat4 scratch becomes loader-owned and allocated from the engine's matrix allocator**. The loader receives the engine, hands a small "loader scratch pool" through the parse / animation / instancing call paths, and the pool's allocations come from `engine._matrixPolicy`.

## Files to modify / create

- `packages/babylon-lite/src/loader-gltf/_loader-scratch.ts` — **NEW**. Internal helper exposing `createLoaderScratch(engine: EngineContextInternal)` returning a small pool of preallocated mat4 scratch buffers. Simplest form: an object `{ tmpA, tmpB, tmpC, ... }` where each is a `Mat4` allocated from `engine._matrixPolicy.allocator.allocate()`.
- `packages/babylon-lite/src/loader-gltf/gltf-parser.ts` — Remove the module-local `_localScratch` (line 164). Replace with a parameter or scoped scratch passed through from the loader entry point. The per-call `world` at line 152 also flows from the scratch pool.
- `packages/babylon-lite/src/loader-gltf/gltf-animation.ts:95` — Replace per-call `new Float32Array(16)` with a borrow from the scratch pool, threaded through the animation sample call signature.
- `packages/babylon-lite/src/loader-gltf/gltf-feature-gpu-instancing.ts:158` — Replace per-instance `new Float32Array(16)` with a per-loop reused scratch (allocated once per parse, not per instance). Allocation comes from the loader scratch pool.
- `packages/babylon-lite/src/loader-gltf/gltf-loader.ts` (or wherever the public `loadGltf` lives — find by grep `export.*loadGltf`) — Create the loader scratch pool at the top of the function and thread it through.

## Implementation details

1. Create `packages/babylon-lite/src/loader-gltf/_loader-scratch.ts`:

   ```ts
   import type { EngineContextInternal } from "../engine/engine.js";
   import type { Mat4 } from "../math/types.js";

   /** @internal Per-loadGltf-call mat4 scratch pool, sourced from the engine policy.
    *  Replaces module-local lazy scratch (which would be shared across engines and
    *  would violate REQ-ARCH-3). */
   export interface LoaderScratch {
       tmpWorld: Mat4;
       tmpLocal: Mat4;
       tmpInstance: Mat4;
       tmpAnim: Mat4;
   }

   export function createLoaderScratch(engine: EngineContextInternal): LoaderScratch {
       const a = engine._matrixPolicy.allocator;
       return {
           tmpWorld: a.allocate(),
           tmpLocal: a.allocate(),
           tmpInstance: a.allocate(),
           tmpAnim: a.allocate(),
       };
   }
   ```

2. Find the `loadGltf` entry point. Common pattern: `packages/babylon-lite/src/loader-gltf/load-gltf.ts` exporting `loadGltf(engine, url, options?)`. At the top of that function, create the scratch:

   ```ts
   const scratch = createLoaderScratch(engine as EngineContextInternal);
   ```

   Pass `scratch` as an additional argument through every internal helper that currently allocates `new Float32Array(16)`.

3. In `gltf-parser.ts`:
    - Delete the module-local `_localScratch` declaration around line 164.
    - The function that previously used `_localScratch` (locate by usage) must accept a `scratch: LoaderScratch` parameter and use `scratch.tmpLocal`.
    - The per-call `world` at line 152 — keep as a per-call local IF it's truly per-call (one allocation per parsed node) AND the function is recursive; otherwise lift it to `scratch.tmpWorld`.

4. In `gltf-animation.ts:95`: change the function signature to accept a `scratch: LoaderScratch` argument, replace `const tmp = new Float32Array(16);` with `const tmp = scratch.tmpAnim;`. Since this scratch is reused across keyframes within a sample call, ensure no caller depends on `tmp` being zero-initialized — every existing assignment overwrites all 16 elements.

5. In `gltf-feature-gpu-instancing.ts:158`: similar — accept a `scratch: LoaderScratch` argument from the parse pipeline, replace `const instWorld = new Float32Array(16) as Mat4` with `const instWorld = scratch.tmpInstance`.

6. Verify with grep at the end:

   ```text
   Select-String -Path .\packages\babylon-lite\src\loader-gltf -Pattern 'new Float32Array\(16\)' -Recurse
   ```

   Expected: zero matches.

## Testing suggestions

- New unit test `tests/unit/gltf-loader-scratch-isolation.test.ts`:
    - Create engine A (HPM off) and engine B (HPM on).
    - `loadGltf(engineA, url)` and `loadGltf(engineB, url)` against a small fixture glb (use one already in `tests/fixtures/` or `lab/public/assets/`).
    - Verify the resulting AssetContainer's first mesh world matrix on engine B is F64-backed.
    - Verify on engine A it is F32-backed.
    - This implicitly validates that the per-load scratch is policy-correct.
- Run an existing glTF-using parity scene (find one in `tests/parity/scenes/`, e.g. a scene that loads `.glb` content) — expect green.
- `pnpm test:parity` — full suite, all glTF-loading scenes pass.
- `pnpm exec vitest run` — green.

## Gotchas

- The function bodies are correct as long as scratch is overwritten before being read. If you find a `tmp[3] = ...` that does NOT also assign every other index, that index reads stale data from the previous call. Audit each scratch usage.
- glTF parsing is recursive. If you replace a per-call `new Float32Array(16) as Mat4` with `scratch.tmpWorld`, recursion will trample the parent's value. **Per-call locals that are used recursively MUST stay per-call.** In that case, allocate from the engine policy at the top of the function via `engine._matrixPolicy.allocator.allocate()` directly — that gets you per-call F64 scratch when HPM is on, without sharing across engines. Use `LoaderScratch` only for non-recursive single-frame scratch.
- Animation evaluation runs on the hot path. If you naïvely allocate per sample call, you regress GC. Verify the scratch lifetime extends across the full animation evaluation (allocate once at the loader entry, reuse for all anim samples). Confirm by counting allocations in a single `loadGltf` call.
- This task does NOT change how `loadGltf` returns its `AssetContainer`. The asset container is consumed by `addToScene` (Task 2.2), where the produced entities get bound to the *destination scene's* policy. If a glb is loaded under engine A's policy and the AssetContainer is then attached to a scene on engine B, the cross-engine fast-fail from Task 2.2 fires. This is correct behavior.
- The asset-container case in `addToScene` (line 294) recursively binds; the glTF caches inside each entity (e.g., mesh world-matrix-state) will get rebound to the destination scene's policy on attach. So precision storage is *re-allocated* on attach, even if the loader allocated under a different policy. This is acceptable for M0 but worth flagging for the reviewer; if any caller relies on identity of the cache buffer pointer pre-attach, that pointer changes on attach. (No current caller does — verified by grep.)

## Verification checklist

- [ ] `packages/babylon-lite/src/loader-gltf/_loader-scratch.ts` exists with `createLoaderScratch` and `LoaderScratch` interface.
- [ ] No module-local `_localScratch` declaration remains in `gltf-parser.ts`.
- [ ] Zero `new Float32Array(16)` matches under `packages/babylon-lite/src/loader-gltf/`.
- [ ] Animation evaluation reuses scratch across the full `loadGltf` call (no per-sample allocation).
- [ ] New unit test `tests/unit/gltf-loader-scratch-isolation.test.ts` confirms loader produces F64 storage on HPM engine and F32 on default engine.
- [ ] `pnpm test:parity` is green for all glTF-using scenes.
- [ ] `pnpm exec vitest run` and `pnpm exec tsc --noEmit` are clean.
