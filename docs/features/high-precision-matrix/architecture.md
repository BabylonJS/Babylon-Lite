# Architecture: `high-precision-matrix`

> Child feature doc for Large World Rendering M0. Read with the parent architecture: [`../../architecture/27-large-world-rendering.md`](../../architecture/27-large-world-rendering.md).

## Executive summary

`useHighPrecisionMatrix` is currently a dead engine flag: the engine stores it, but `Mat4` is still hard-wired to `Float32Array`, world/camera caches allocate F32, and GPU uploaders often copy matrices directly into `Float32Array` views. That fails `REQ-API-2`, `REQ-MAT-1`, `REQ-UPL-1`, and `REQ-INT-1`.

This architecture makes the flag load-bearing by introducing an engine-owned matrix-precision policy, widening `Mat4` to an opaque dual-backend typed-array abstraction, and creating a single explicit F64→F32 packing boundary for GPU upload. The design keeps Lite data-oriented (`GUIDANCE.md` §4b, §4b′), avoids module-level allocator state (`REQ-ARCH-1..3`), and preserves tree-shaking by keeping F64-only allocation and packing paths behind the engine policy (`REQ-ARCH-6`).

### Requirement concerns / resolved assumptions

- The requirements name a fixed M0 uploader inventory in REQ-UPL-2 (mesh world UBO writes, camera view/projection UBO writes, light UBO writes, thin-instance buffer writes, shadow-matrix writes). The repository sweep also surfaces other matrix-to-GPU writers — notably `picking/gpu-picker.ts` (`_pickVP`), the skybox world matrix in `loader-skybox/load-skybox.ts`, and the Gaussian-splat sort matrix in `mesh/gaussian-splatting-mesh.ts`. These are **explicitly deferred to a follow-up milestone** (LWR M1 or a dedicated audit pass) and are **not** part of M0 acceptance. M0 ships the fixed REQ-UPL-2 inventory only; the audit script enforces that the inventory writers route through the boundary, and the deferred sites are tracked in the implementation plan (T-05) so they cannot be quietly forgotten.
- `gltf-parser.ts` currently uses module-local lazy scratch for TRS composition. That pattern is acceptable for F32-only math, but it is not acceptable for a precision mode that must remain per-engine. M0 therefore replaces precision-bearing mat4 scratch with loader- or scene-owned scratch bound to the owning engine policy.

### Before / after

| Area | Before | After |
|---|---|---|
| Engine option | `useHighPrecisionMatrix` stored but not consumed | Engine owns a real matrix-precision policy (`REQ-INT-1`) |
| Public mat4 type | `Mat4` is a branded `Float32Array` | `Mat4` stays one opaque nominal type, internally backed by F32 or F64 (`REQ-API-1`, `REQ-API-4`) |
| Allocation | In-scope creators hardcode `new Float32Array(16)` | In-scope creators allocate from engine-bound policy (`REQ-MAT-1`, `REQ-ARCH-4`) |
| CPU readers | World/camera/picking/thin-instance readers consume F32 storage | Fixed M0 reader inventory consumes precision-preserving storage directly (`REQ-CPU-1..3`) |
| GPU upload | Many direct `Float32Array.set(mat)` / `writeBuffer(mat)` patterns | All mat4 GPU writes pack through one F64→F32 boundary (`REQ-UPL-1..3`) |
| Thin instances | Public bulk setter is `Float32Array`-only | Bulk setter accepts F32 or F64 packed matrices; single-matrix setters stay `Mat4`-based (`REQ-API-5`) |
| M1 seam | `useFloatingOrigin` is scene-local but not validated against engine precision | Scene creation resolves precision policy once, so M1 can add a deterministic guard there (`REQ-INT-2`) |

## Current architecture overview

### Current flow

```text
createEngine(options)
    |
    +-- engine.useHighPrecisionMatrix = true/false   (stored only)

mesh/light/camera factories
    |
    +-- allocate Float32Array(16)
    +-- world/view/proj caches stay Float32Array

CPU world-space readers
    |
    +-- consume F32-backed matrices

GPU uploaders
    |
    +-- data.set(mat)
    +-- queue.writeBuffer(... mat ...)
```

### Current pressure points

```text
engine.ts
  stores precision flag
       |
       X not read by allocators or kernels

math/types.ts
  Mat4 := Float32Array brand
       |
       X type forbids Float64 backing

scene/camera/light/loader code
  new Float32Array(16)
       |
       X precision lost before GPU boundary

render/upload paths
  Float32 scratch.set(mat)
       |
       X multiple silent downcast sites
```

Representative existing constraints from the codebase:

- `Mat4` is currently `Float32Array & { __brand: "Mat4" }` in `packages/babylon-lite/src/math/types.ts`.
- `createWorldMatrixState()` owns a preallocated `Float32Array(16)` cache in `packages/babylon-lite/src/scene/world-matrix-state.ts`.
- Camera caches `_viewCache`, `_projCache`, `_vpCache` are `Float32Array` in `packages/babylon-lite/src/camera/camera.ts`.
- Thin-instance CPU storage is `Float32Array` in `packages/babylon-lite/src/mesh/thin-instance.ts`.
- PBR, Standard, Node, shadow, picking, frame-graph, and thin-instance uploaders write matrices directly into F32 GPU upload views.

## Key architectural changes

### Architecture at M0

```text
EngineContextInternal
  └─ matrix precision policy (f32 | f64)
        |
        +-- createMat4 / createMat4Buffer / convertMat4
        +-- packMat4IntoF32
        |
SceneContextInternal
  └─ captures engine policy once
        |
        +-- addToScene / registerScene bind matrix-owning state
        +-- loaders/builders thread policy explicitly
        |
Mat4 producers/caches/readers
  └─ keep source storage in F32 or F64
        |
GPU uploaders
  └─ always call packMat4IntoF32(...)
```

### Allocation and upload split

```text
CPU side                            GPU side
--------                            --------
engine policy decides storage       WGSL stays mat4x4<f32>
mesh/world/view/proj caches         upload scratch is Float32Array
thin-instance CPU arrays            packMat4IntoF32 is sole downcast
loader scratch/world caches         queue.writeBuffer receives only F32
```

## Decisions

### D1. Internal `Mat4` representation

Decision: `Mat4` remains a **single opaque branded nominal type** whose declared TypeScript shape does **not** expose `Float32Array | Float64Array`. The public `.d.ts` MUST contain no `Mat4F32`, `Mat4F64`, or `Float32Array | Float64Array` union associated with `Mat4`.

Concretely, `packages/babylon-lite/src/math/types.ts` exports:

```ts
// Public (.d.ts will contain only this shape — no union, no Float64Array)
export interface Mat4 {
    readonly __brand: "Mat4";
    readonly length: 16;
    readonly [index: number]: number;
}
```

Internal-only (not re-exported from the package entry; lives in an internal
module such as `math/_mat4-storage.ts` that is not part of the package's
public surface, so the union never appears in any emitted `.d.ts` reachable
from `packages/babylon-lite/src/index.ts`):

```ts
// Internal storage view used by kernels, allocators, and the upload packer.
export type Mat4Storage = Float32Array | Float64Array;
// Internal cast helpers go from opaque Mat4 to the storage view and back.
```

Rationale:

- Satisfies `REQ-API-1` and `REQ-API-4`: callers see one `Mat4` concept and no precision-specific types in the public surface.
- The `.d.ts` for `@babylonjs-lite/...` will not contain `Float32Array | Float64Array` for any `Mat4` symbol. This is the form of opacity required to keep user code stable when the F64 backing lands.
- Internal allocators / kernels / upload packer still get strongly typed access via the internal `Mat4Storage` alias and explicit casts at internal boundaries, so we preserve typed-array performance and data-orientation without leaking storage detail.
- Internal storage detection at hot paths uses runtime checks (`m instanceof Float64Array` or `m.BYTES_PER_ELEMENT === 8`) inside the engine and packer, behind the opaque type.

Rejected alternatives:

- Publicly exposing `Mat4F32` / `Mat4F64` (or `Mat4 = Mat4F32 | Mat4F64`) would leak precision policy into user code, would appear in `.d.ts`, and would violate `REQ-API-1`.
- A public union `Mat4 = Float32Array | Float64Array` is also rejected for the same `.d.ts`-leak reason.
- A wrapper object or class around storage would violate the typed-array/data-oriented constraint.
- Keeping `Mat4` nominally opaque but hiding storage behind non-typed-array handles would break existing assumptions in readers and upload code.

Verifiability: see Testing strategy step 6, which adds an explicit `.d.ts`
inspection step that fails if any emitted declaration in the package's
public entry contains `Mat4F32`, `Mat4F64`, or a `Float64Array`-containing
union associated with `Mat4`.

### D2. Allocator wiring

Decision: use a hybrid design with **named, exact bind points**:

1. **Engine-level policy.** `createEngine(canvas, options)` resolves `options.useHighPrecisionMatrix === true` into an internal matrix-precision policy stored on `EngineContextInternal`. This is the single source of truth; no module-global state exists.
2. **Scene-level capture.** `createSceneContext(engine, options)` snapshots that engine policy onto `SceneContextInternal` at scene construction time (the same constructor that today initialises `_floatingOriginMode`, `_eyePosition`, and `_floatingOriginOffset` — see `packages/babylon-lite/src/scene/scene-core.ts:152`). Snapshotting at this exact call site keeps the scene's view of precision stable for its lifetime.
3. **Entity bind.** Matrix-owning entities created by `createMesh`, `createCamera`, `createHemisphericLight`, `createDirectionalLight`, `createSpotLight`, `createPointLight`, `createShadowGenerator`, `createTransformNode`, and `loadGltf` start **unbound** (factories take no scene per `GUIDANCE.md` §4b). Binding happens at exactly two call sites:
   - `addToScene(scene, entity)` — `packages/babylon-lite/src/scene/scene-core.ts:291` — binds the entity's matrix-owning state (mesh `worldMatrixState`, camera `_viewCache`/`_projCache`/`_vpCache`, light local/world caches, shadow caster scratch) to the scene's captured precision policy and allocates any policy-backed storage at this moment.
   - `registerScene(engine, scene)` — `packages/babylon-lite/src/scene/scene-core.ts:401` — runs deferred builders and loader scratch under the same captured policy.

   No other API may mutate an entity's precision binding.

4. **Same-engine reattach.** Removing an entity from one scene and re-`addToScene`-ing it to a different scene on the **same** engine is permitted and is a no-op for precision binding (the engine policy has not changed; the entity's storage is already valid).
5. **Cross-engine reattach — fast-fail.** `addToScene` MUST detect the case where an already-bound matrix-owning entity is being attached to a scene whose engine has a **different** matrix-precision policy than the engine the entity was first bound to, and MUST throw a configuration error synchronously at that `addToScene` call. One entity cannot safely own contradictory storage policies, and this is the only safe boundary at which to detect the conflict.
6. **Device change.** If the engine's device is rebuilt (a different `GPUDevice` is acquired), the engine policy persists (it is a CPU-side decision), but any `Mat4Storage`-backed caches that survive the device change continue to function. No stale shared allocator state can leak because no module-level allocator exists.

Rationale:

- Satisfies `REQ-ARCH-1..5`: the policy is per-engine, side-effect-free, and survives device lifecycle changes because it is engine-owned state, not module state.
- Avoids the worst downside of full parameter threading: camera/light/mesh factories are intentionally scene-agnostic per `GUIDANCE.md` §4b.
- Avoids the rejected design from goals: no module-global lazy allocator.
- Fits existing seams: `createSceneContext`, `addToScene`, `registerScene`, deferred builders, and glTF loaders already receive engine/scene handles.
- Names the exact functions that own each lifecycle step so the implementation plan (T-05) has no ambiguity about where to plug in.

### D3. Kernel strategy on hot paths

Decision: use generic CPU mat4 kernels for M0, specialized only by destination allocation and by the explicit upload packer. To preserve HPM-off tree-shakeability (`REQ-ARCH-6`), all F64-only allocation, storage, and packing code is isolated into dedicated modules that are only reachable through a top-level branch in `createEngine` gated by `options.useHighPrecisionMatrix === true`.

Tree-shaking mechanism (concrete):

1. **Module isolation.** F64-only code lives in clearly named, side-effect-free modules: `packages/babylon-lite/src/math/_mat4-storage-f64.ts` (Float64Array allocators), `packages/babylon-lite/src/math/pack-mat4-into-f32.ts` (F64→F32 upload packer; the F64 branch is the only branch that uses the F64-aware path). These modules are never imported from any module reachable when HPM is off.
2. **Single gated import site.** The engine policy resolver in `createEngine` is the **only** place that imports the F64 storage module, and it does so via a **dynamic `await import(...)` inside `if (useHpm)`**. A top-level static import + `if`-guarded call was originally proposed but produced no DCE in practice (bundlers cannot prove the runtime `useHpm` boolean is false and therefore retained the F64 module in every bundle). Generic kernels operate on the internal `Mat4Storage` view and never name the F64 module by import.
3. **`sideEffects: false` enforcement.** `packages/babylon-lite/package.json` already declares `sideEffects: false` (or its specific allowlist); the F64 modules MUST NOT be added to any side-effects allowlist. With the dynamic-import gate in place, the F64 module is emitted as a side chunk that HPM-off bundles never fetch and HPM-on bundles load on demand inside `createEngine`.
4. **Verification.** `pnpm build:bundle-scenes` plus the existing bundle-size ceilings act as the regression gate: any scene that does not opt into `useHighPrecisionMatrix` must not see a ceiling increase attributable to F64 modules. The T-05 implementation plan adds a bundle-content assertion that the emitted bundle for an HPM-off scene contains no symbol from `_mat4-storage-f64.ts` or the F64 branch of the packer.

Rationale:

- Existing kernels already compute in JavaScript `number`; most precision-specific behavior is in the typed-array backing, not in different arithmetic code paths.
- One generic kernel per operation keeps bundle growth down and best supports `REQ-ARCH-6`; the F64 cost is paid only by HPM-on scenes via the gated import.
- Duplicating every mat4 kernel into F32 and F64 variants would double maintenance and fetched bytes before the project has evidence that the F32 fast path needs that complexity.
- The only deliberately specialized boundary is F64→F32 upload packing, because that is where representation actually changes.

Hot-path JIT / monomorphism risk:

Generic kernels accept `Mat4Storage = Float32Array | Float64Array`, which is a polymorphic typed-array input. V8 and other engines can deoptimize a hot site that observes both shapes. M0 accepts this risk because (a) `pnpm test:perf` is the user/CI gate and any measured regression triggers `T-05` to split only the proven hotspot, and (b) within a single engine instance the policy never changes, so a given kernel call site only ever sees one storage shape per engine lifetime. The fallback trigger is explicit: if any post-M0 perf run shows a regression that profiling traces to a polyomorphic mat4 kernel, that specific kernel — and only that kernel — gets duplicated into `mat4-*-f32.ts` and `mat4-*-f64.ts` and dispatched at the engine boundary, keeping the rest of the math layer generic.

Rejected alternative: fully duplicated F32/F64 kernels across `math/` were rejected for M0 because they add bytes immediately while the performance case is still hypothetical and agents cannot validate `test:perf` (`REQ-VER-2`). If later user/CI perf evidence shows a real regression, T-05 may split only the proven hotspots per the fallback trigger above.

### D4. GPU upload boundary

Decision: place `packMat4IntoF32` in a new pure math helper module, `packages/babylon-lite/src/math/pack-mat4-into-f32.ts`, with the contract: write one `Mat4` into a `Float32Array` view at an optional float offset, without allocating and without applying floating-origin offsets.

Rationale:

- The helper is numeric, not GPU-object-specific, so it belongs in `math/`, not on the engine or resource layer.
- It mirrors existing Lite patterns such as `write-vec3.ts`: pure data packing into a caller-owned scratch view.
- It directly satisfies `REQ-UPL-1..3`.

Enforcement:

1. All in-scope uploaders call this helper before `createUniformBuffer` / `queue.writeBuffer`.
2. The implementation adds a repository audit that fails review if direct mat4-to-F32 GPU writes remain outside the approved helper module(s).
3. Final agent validation remains `pnpm build:bundle-scenes`, focused parity while iterating, and `pnpm test` as the full gate (`REQ-VER-1..4`).

M0 uploader inventory to route through the boundary (fixed, from REQ-UPL-2 — no additions):

- mesh world UBO writes;
- camera view/projection/view-projection UBO writes;
- light UBO writes where matrices feed GPU state;
- thin-instance GPU vertex-buffer writes;
- shadow view/light/world matrix writes.

**Out of scope for M0**, deferred to a follow-up audit pass tracked in T-05: the adjacent mat4-to-GPU writers found during the sweep — `picking/gpu-picker.ts` (`_pickVP`), the skybox world matrix in `loader-skybox/load-skybox.ts`, and the Gaussian-splat sort matrix in `mesh/gaussian-splatting-mesh.ts`. The repository audit in step 2 above only enforces the boundary for the REQ-UPL-2 inventory; the deferred sites are listed in the implementation plan so they cannot be silently forgotten when the follow-up milestone begins.

### D5. Thin-instance public API shape

Decision: widen the bulk thin-instance setter to accept packed `Float32Array` or packed `Float64Array`, while keeping single-instance APIs on `Mat4`.

Rationale:

- Satisfies `REQ-API-5` with the smallest public change.
- Preserves existing Float32 callers unchanged.
- Lets high-precision callers pass packed F64 matrix slabs directly, matching the current flat-array usage style.
- Avoids inventing a second bulk API or forcing callers to flatten `Mat4[]` just to satisfy typing.

Internal data model impact:

- `ThinInstanceData.matrices` becomes a packed matrix slab that may be F32 or F64.
- CPU readers (for picking / detailed picking) read directly from that source storage.
- GPU sync loops pack dirty ranges into F32 upload scratch right before `writeBuffer`.

Other thin-instance bulk/import paths:

The bulk widening lands on `setThinInstances` as the single bulk setter; no other public bulk thin-instance API exists in Lite today. Internally, `mesh/thin-instance.ts` and `mesh/thin-instance-gpu.ts` already accept the slab through one entry point, so no second public path needs widening. glTF instancing currently funnels through `setThinInstances` after composing per-instance matrices, so the loader inherits the widened slab contract for free; the loader path itself does not need a separate F64 setter. If a future loader (e.g. an instanced-format extension) introduces a new bulk path, it must adopt the same widened slab contract, but that work is out of M0 scope.

Rejected alternatives:

- A sibling API such as `setThinInstances64(...)` was rejected as needless API surface.
- A `Mat4[]`-only bulk API was rejected because it diverges from the existing packed-array pattern and would force new flattening work onto F32 callers.

### D6. Validation hook for M1

> **⚠ SUPERSEDED by commit `07be57e` (engine-at-construction simplification).**
> The `ScenePrecisionPolicy` interface and `resolveScenePrecisionPolicy`
> resolver described below have been deleted. Entities now take `engine`
> at construction and allocate caches from `engine._matrixPolicy.allocator`
> directly. The M1 validation guard described in step (3) below can land
> as a check inside `createSceneContext` against `engine._matrixPolicy.storageKind`
> when needed. See `GUIDANCE.md` pillar 4b″.

Decision: introduce a dedicated scene-creation precision-resolution seam in `createSceneContext`; M0 uses it to capture engine precision policy, and M1 will extend the same seam to assert `useFloatingOrigin: true` requires engine high-precision mode.

Internal API contract (M0):

```ts
// In packages/babylon-lite/src/scene/scene-core.ts, internal to the module.
// Called synchronously inside createSceneContext, after the existing
// _floatingOriginMode / _eyePosition / _floatingOriginOffset block.
function resolveScenePrecisionPolicy(
    engine: EngineContextInternal,
    sceneOptions: SceneOptions,
): ScenePrecisionPolicy;

interface ScenePrecisionPolicy {
    readonly useHighPrecisionMatrix: boolean; // mirrored from engine
    readonly storageKind: "f32" | "f64";       // derived from the above
}
```

The resolver:

1. Reads the engine's resolved matrix-precision policy (set during `createEngine`).
2. In M0, returns the engine policy unchanged; `sceneOptions` does not yet contribute. This is the field that `SceneContextInternal` stores and that `addToScene` / `registerScene` consult when binding entity storage (see D2).
3. In M1, the same resolver gains one additional guard: if `sceneOptions.useFloatingOrigin === true` and the engine policy is not high-precision, the function throws a configuration error synchronously at `createSceneContext` time. M1 changes are limited to that branch; M0 callers, contract, and return shape stay untouched.

This keeps the validation hook orthogonal to mat4 math kernels and uploaders, gives M1 a one-line code change instead of a structural one, and matches `REQ-INT-2`.

Rationale:

- Satisfies `REQ-INT-2` without module state or heuristics.
- `createSceneContext` already owns `_floatingOriginMode`, `_eyePosition`, and `_floatingOriginOffset`, so it is the correct place to validate the scene/engine contract once.
- Keeps future floating-origin validation orthogonal to mat4 math kernels and uploaders.

Rejected alternative: validating lazily during render/update was rejected because it would delay a configuration error until runtime behavior had already diverged.

## Component deep dives

### 1. Type-system widening plan

Target shape:

- Public: `Mat4` remains the only exported matrix type used by public APIs (`REQ-API-1`, `REQ-API-4`).
- Internal: storage-specific branded variants exist for F32 and F64.
- Kernel inputs: in-scope mat4 math/read helpers stop requiring `Float32Array` specifically.
- Cache fields: camera/world/light/loader caches become policy-backed mat4 storage instead of hard-coded F32 arrays.

Affected component families:

```text
math/
  mat4 constructors + *Into helpers
scene/
  world matrix caches, parent preservation
camera/
  view/proj/vp caches, getCameraPosition
light/
  local/world matrix helpers
loader-gltf/
  node world cache, skin scratch feeding world-space outputs
mesh/
  thin instance storage and readers
```

### 2. Allocator wiring diagram

```text
createEngine
  └─ engine._matrixPolicy
        |
createSceneContext
  └─ scene._matrixPolicy
        |
addToScene / registerScene / buildScene
  ├─ bind mesh world-matrix state
  ├─ bind camera caches
  ├─ bind light local/world caches
  └─ bind deferred builders / loaders
        |
mat4 producers allocate matching storage
```

Binding rules:

- Standalone factory-created entities may start unbound.
- The first scene attachment binds them to the owning engine policy.
- Precision-bearing scratch owned by loaders/builders is created from scene/engine policy at build time, never from module-global state.
- Rebinding an already-bound entity to a conflicting engine policy is a configuration error for M0.

### 3. GPU upload boundary contract

Contract:

- Input: one `Mat4` in source precision.
- Output: caller-owned `Float32Array` upload view.
- Responsibilities: copy numeric elements only.
- Non-responsibilities: no eye-offset subtraction, no camera special-casing, no allocation, no GPU side effects.

```text
Mat4 source (F32 or F64)
        |
        v
packMat4IntoF32(uploadScratch, mat [, offset])
        |
        v
createUniformBuffer / queue.writeBuffer / vertex-buffer upload
```

This keeps M0 precision-only and leaves LWR offset math to M1 (`REQ-UPL-3`, `REQ-COMP-3`).

### 4. CPU reader coverage

The implementation sweep must keep the fixed M0 reader inventory on source storage (`REQ-CPU-1..3`):

- `scene/world-matrix-state.ts`
- `scene/set-parent.ts`
- `camera/camera.ts` caches and position readers
- `picking/ray.ts`
- `picking/detailed-picking.ts`
- `frame-graph/render-task.ts`
- `material/pbr/scene-size.ts`
- thin-instance matrix reads
- glTF scratch/world-cache paths whose outputs feed world-space results

Reader rule:

```text
CPU reader needs world-space truth?
    yes -> read Mat4 directly in source storage
    no  -> out of M0 unless it feeds the named matrix surface
```

### 5. Migration strategy

For existing Babylon Lite callers (`REQ-API-3`, `REQ-COMP-2`):

- scenes that never enable `useHighPrecisionMatrix` keep today’s behavior;
- public mat4-facing APIs stay stable;
- thin-instance Float32 usage keeps working unchanged.

For Babylon.js migrants (`REQ-COMP-1`):

- the same engine flag becomes meaningful;
- CPU precision survives through world composition, inverse, caches, and readers until upload;
- thin-instance callers may pass packed `Float64Array` data without pre-downcasting.

No data migration is required because the feature is runtime policy, not serialized schema.

### 6. Code removal plan

M0 removes patterns, not features:

- remove the silent no-op nature of `useHighPrecisionMatrix` by making engine precision state load-bearing;
- remove hard-coded in-scope mat4 allocations that assume `Float32Array` storage;
- remove direct matrix GPU writes outside the shared pack boundary;
- remove precision-bearing module-local mat4 scratch where it would violate per-engine isolation.

No public API deletions are planned.

## Data model changes

| Component | Change | Requirements |
|---|---|---|
| `EngineContextInternal` | add internal matrix precision policy/state derived from `useHighPrecisionMatrix` | `REQ-API-2`, `REQ-INT-1`, `REQ-ARCH-1..5` |
| `SceneContextInternal` | capture engine matrix policy at scene creation for later validation/binding | `REQ-INT-2` |
| `Mat4` internals | widen storage from F32-only to opaque dual backend | `REQ-API-1`, `REQ-MAT-1` |
| camera caches | `_viewCache`, `_projCache`, `_vpCache` become policy-backed mat4 storage | `REQ-MAT-2`, `REQ-CPU-2` |
| world-matrix state | owned world cache becomes policy-backed; parent multiply stays on source storage | `REQ-MAT-1`, `REQ-CPU-2` |
| `ThinInstanceData` | `matrices` may be packed F32 or F64 CPU storage | `REQ-API-5`, `REQ-MAT-2` |
| loader scratch/world caches | glTF world-cache and relevant scratch become scene/engine-bound | `REQ-MAT-2`, `REQ-ARCH-1..5` |

## Risks and mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Hidden F32 downcast survives in one uploader | Breaks `REQ-UPL-1` and makes precision bugs scene-specific | Source audit plus single helper policy; implementation plan enumerates each upload site |
| Cross-engine reuse of one matrix-owning entity | One object cannot safely own conflicting precision policies | Detect conflicting rebinds and fail fast in M0 |
| Bundle growth in HPM-off scenes | Violates `REQ-ARCH-6` | F64 storage/packer code lives in dedicated modules imported only behind the `createEngine` HPM flag, kept off the `sideEffects` allowlist, and verified by `pnpm build:bundle-scenes` plus a T-05 bundle-content assertion that the F64 module symbols are absent from HPM-off scene bundles |
| glTF/animation scratch accidentally remains global | Violates per-engine isolation | Move precision-bearing scratch to scene/loader-owned state |
| M1 offset logic leaks into M0 packer | Would violate `REQ-UPL-3` and blur milestone boundaries | Keep packer precision-only; reserve offset math for later scene-level helpers |

## Testing strategy overview

Agent-allowed verification only (`REQ-VER-1..4`):

1. During implementation, iterate on a **new dedicated parity scene** added in M0 (id allocated in T-05) that demonstrates the ~1e5-coordinate jitter case with and without engine high-precision mode. Existing parity scenes are not modified — they continue to serve as the HPM-off regression baseline, and the new scene serves as the HPM-on acceptance fixture. This keeps `reference/` for existing scenes immutable per the guardrails.
2. Run `pnpm build:bundle-scenes` to verify scene bundles still build and no bundle-size ceiling is exceeded, including the new HPM-off scenes confirming F64 modules are tree-shaken (D3).
3. Run focused parity while iterating when a single scene is under development.
4. Run `pnpm test` as the final agent gate, which covers build plus parity without perf tests.
5. Review diff for `reference/` and bundle-size ceiling files to ensure no forbidden updates landed.

Acceptance evidence expected from M0:

- one parity scene proving the flag is no longer a no-op (`REQ-MAT-4`, `REQ-COMP-1`);
- green build/parity guardrails with unchanged reference images and bundle ceilings (`REQ-VER-1..4`);
- repo audit evidence that direct mat4 GPU writes outside the pack helper are gone (`REQ-UPL-2`).

## Files to modify / create / delete appendix

Planned creates:

- `packages/babylon-lite/src/math/pack-mat4-into-f32.ts`
- unit or audit coverage files chosen in T-05
- parity scene assets/spec selected in T-05

Planned modifications (minimum expected set):

- `packages/babylon-lite/src/math/types.ts`
- `packages/babylon-lite/src/math/mat4-*.ts`
- `packages/babylon-lite/src/engine/engine.ts`
- `packages/babylon-lite/src/scene/world-matrix-state.ts`
- `packages/babylon-lite/src/camera/camera.ts`
- `packages/babylon-lite/src/scene/scene-core.ts`
- `packages/babylon-lite/src/mesh/thin-instance.ts`
- `packages/babylon-lite/src/mesh/thin-instance-gpu.ts`
- `packages/babylon-lite/src/loader-gltf/gltf-parser.ts`
- `packages/babylon-lite/src/loader-gltf/gltf-animation.ts`
- matrix uploaders in render/material/shadow/picking paths

Planned deletions:

- none; M0 replaces patterns in place.

## Rejected alternatives summary

1. Module-global allocator or precision registry: rejected by `GUIDANCE.md` §4 and `REQ-ARCH-1..3`.
2. Public precision-specific matrix types: rejected because they leak implementation detail and break migration ergonomics.
3. Full F32/F64 kernel duplication in M0: rejected as premature bundle/perf complexity.
4. A second thin-instance API just for F64: rejected as unnecessary surface area.
5. Late render-time validation of floating-origin prerequisites: rejected because configuration errors should fail at scene creation.

## Open issues for implementation-plan phase (T-05)

Remaining T-05-level questions (architecture-level questions raised in review have been promoted into D1–D6 above):

1. Exact allowlist/denylist patterns for the upload-boundary source audit (which file globs and which regex rules constitute a violation).
2. Concrete parity-scene design and scene id allocation for the ~1e5 precision regression fixture (the new HPM-on acceptance scene referenced in Testing strategy step 1).

Resolved in this architecture:

- Internal binding seam for matrix-owning entities → D2 (`addToScene` + `registerScene`, with same-engine reattach allowed and cross-engine reattach fast-failing).
- Whether out-of-inventory uploaders enter M0 → D4 (no; deferred to a follow-up audit pass, with the discovered sites listed for traceability).
- Cross-engine fast-fail behavior → D2 §5 (synchronous configuration error at `addToScene`).
- Naming of internal engine/scene precision-policy fields → D6 (`ScenePrecisionPolicy` internal interface; public surface is unaffected).
