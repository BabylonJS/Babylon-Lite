# Task 2.3: World, camera, light, and shadow caches allocate via policy

> **⚠ SUPERSEDED by commit `07be57e` (engine-at-construction simplification).**
> This task originally migrated caches to a default-F32-at-construction +
> rebind-on-attach pattern via `_rebindAllocator`. After the simplification,
> camera factories (`createArcRotateCamera`, `createFreeCamera`), light
> factories (`createDirectionalLight`, `createHemisphericLight`,
> `createSpotLight`, `createPointLight`), `createSceneNode`,
> `createTransformNode`, mesh `initMeshTransform`, and `createShadowCamera`
> all take `engine` at construction and allocate matrix caches from
> `engine._matrixPolicy.allocator` directly. The `_rebindAllocator` hook
> has been deleted from every interface.
>
> Kept as historical record of the original M0 design.

## Goal

Migrate every M0-scope matrix-owning cache from hard-coded `new Float32Array(16) as Mat4` allocation to allocation via the captured scene `_matrixPolicy.allocator`. After this task, when `useHighPrecisionMatrix: true`, world matrices, camera view/projection/view-projection caches, light local/world caches, and shadow caster scratch all hold `Float64Array(16)` storage on CPU. CPU readers continue to consume the matrices through `Mat4Storage` indexing, which is precision-agnostic.

## Requirements addressed

REQ-MAT-1, REQ-MAT-2, REQ-CPU-1, REQ-CPU-2, REQ-CPU-3, REQ-ARCH-4.

## Background

The architecture (Component deep dive §2 "Allocator wiring diagram") names the call sites: caches are allocated when an entity is bound to a scene (Task 2.2), and the scene's allocator is captured by Task 2.1.

Today the precision-bearing caches in scope for M0 are:

- `packages/babylon-lite/src/scene/world-matrix-state.ts:37` — `_ownedWorld` (mesh world matrix cache).
- `packages/babylon-lite/src/camera/camera.ts:45,76,91` — `_viewCache`, `_projCache`, `_vpCache`.
- `packages/babylon-lite/src/camera/free-camera.ts:43` — `_localMat`.
- `packages/babylon-lite/src/light/directional-light.ts:20`, `light/hemispheric.ts:22`, `light/spot-light.ts:26` — `_localMatrix`.
- `packages/babylon-lite/src/light/light-matrix.ts:26` — out-param defaults.
- `packages/babylon-lite/src/shadow/shadow-base.ts:125` — output buffer.
- `packages/babylon-lite/src/shadow/shadow-generator.ts:140`, `shadow/pcf-shadow-generator.ts:112`, `shadow/pcf-directional-shadow-generator.ts:145` — `proj` matrices.
- Scratch matrices used by the kernels (`mat4-identity.ts:5`, `mat4-compose.ts:6`, etc.) that *return* a fresh `Mat4` — these allocate on every call and are temporary; in M0 they continue to allocate F32 because (a) they are general-purpose helpers without a policy reference, and (b) the result is normally consumed by an `*Into` kernel that copies into a policy-allocated cache anyway. **Leave the kernel allocators on F32.** The TODO tags from Task 1.1 can be removed if you confirm this.

The bind point is when the owning entity gets attached to a scene (Task 2.2). At that point `entity._boundPolicy.allocator` is available. Caches that are owned by *modules* (e.g., shadow output buffers in `light-matrix.ts:26` or `shadow-base.ts:125`) need to take the allocator as an argument from their callers, which by that point all live downstream of an entity binding.

`world-matrix-state.ts` is currently constructed by callers like `Mesh` and `TransformNode`. Those constructions happen inside the entity factory, before any scene attach. The cleanest fix is to make `createWorldMatrixState()` accept an allocator parameter that defaults to F32 (factory time), and to **rebind** the cache to the policy-correct storage at attach time inside `bindEntityMatrixPolicy` from Task 2.2.

## Files to modify / create

- `packages/babylon-lite/src/scene/world-matrix-state.ts` — Add an internal `_rebindAllocator(allocator: MatrixAllocator)` method that reallocates `_ownedWorld` from the new allocator and clears the cache. Default factory still uses `new Float32Array(16)`.
- `packages/babylon-lite/src/scene/_entity-precision-bind.ts` — When binding a mesh/camera/light/transform-node, call any `_rebindAllocator` hook the entity exposes for its caches.
- `packages/babylon-lite/src/camera/camera.ts` — In `getViewMatrix`, `getProjectionMatrix`, `getViewProjectionMatrix` (the three places that lazy-init `_viewCache`/`_projCache`/`_vpCache`), allocate from `camera._boundPolicy?.allocator` if available, else fall back to `new Float32Array(16)`.
- `packages/babylon-lite/src/camera/free-camera.ts` — `_localMat` becomes a closure-local `Mat4` lazily allocated on first read; in `bindEntityMatrixPolicy` we trigger a re-init via a `_rebindAllocator` method on the camera.
- `packages/babylon-lite/src/light/directional-light.ts`, `hemispheric.ts`, `spot-light.ts` — Same pattern: lazy `_localMatrix` initialized via the bound policy on first read after attach.
- `packages/babylon-lite/src/light/light-matrix.ts` — The function takes `out?: Mat4`; existing default `new Float32Array(16) as Mat4` allocator stays, but when callers (lights themselves) pass a policy-allocated `out`, that storage is honored. Verify no caller defaults the `out` param; if any does, fix that caller to pass policy-allocated storage.
- `packages/babylon-lite/src/shadow/shadow-base.ts:125` and `shadow-generator.ts:140`, `pcf-shadow-generator.ts:112`, `pcf-directional-shadow-generator.ts:145` — These allocate per shadow-generator instance. ShadowGenerator gains a `_boundPolicy` field via Task 2.2. Replace `new Float32Array(16)` at each of these lines with `boundPolicy.allocator.allocate()` (after the generator is bound; default to F32 if used pre-bind, but assert in Task 4.1 that no shadow generator is sampled pre-attach).
- `packages/babylon-lite/src/scene/_entity-precision-bind.ts` (extend) — call `entity._rebindAllocator?.(policy.allocator)` after setting `_boundPolicy`. Encode the convention: any entity that owns mat4 caches exposes a `_rebindAllocator(alloc: MatrixAllocator): void` method; the helper invokes it if present.

## Implementation details

1. In `packages/babylon-lite/src/scene/world-matrix-state.ts`, change:

    ```ts
    const _ownedWorld = new Float32Array(16) as Mat4;
    ```

    to:

    ```ts
    let _ownedWorld: Mat4 = new Float32Array(16) as unknown as Mat4;
    ```

    and expose a method on the returned `WorldMatrixAccessors` (extend the interface):

    ```ts
    _rebindAllocator(allocator: MatrixAllocator): void {
        _ownedWorld = allocator.allocate();
        _cachedWorld = null;
        _lastLocalVersion = -1;
        _lastParentVersion = -1;
    }
    ```

    Update the existing `getWorldMatrix` body to keep using `_ownedWorld` (the variable is now `let`, not `const`). Cast to `Mat4Storage` where needed using `asMat4Storage` from Task 1.1.

2. The mesh internal interface (`MeshInternal`) carries a `WorldMatrixAccessors` instance. In Task 2.2 we added `bindEntityMatrixPolicy`. Extend `bindEntityMatrixPolicy` (or add a sibling helper called immediately after) to dispatch a `_rebindAllocator(policy.allocator)` call to any matrix-owning child accessor on the entity. For mesh, that means walking to the mesh's `WorldMatrixAccessors` and calling `_rebindAllocator`. For camera, calling a new `_rebindAllocator` method on the camera that re-allocates `_viewCache`, `_projCache`, `_vpCache`, and `_localMat`.

3. For caches that lazy-init only on first read (e.g., `getViewMatrix`'s `if (!camera._viewCache) { camera._viewCache = new Float32Array(16); }` at line 44–45), the simplest correct change is:

    ```ts
    if (!camera._viewCache) {
        camera._viewCache = camera._boundPolicy
            ? (camera._boundPolicy.allocator.allocate() as unknown as Float32Array)
            : new Float32Array(16);
    }
    ```

    Note the existing field type is `Float32Array`, but a `Float64Array` returned by the F64 allocator does not satisfy `Float32Array`. Widen `_viewCache`/`_projCache`/`_vpCache` field declarations to `Mat4` (the opaque type from Task 1.1), and update the body to use `asMat4Storage` for index reads/writes.

    The body of `getViewMatrix` does direct numeric assignments `v[0] = ...; v[1] = ...;` — those are precision-agnostic and continue to work.

4. The same pattern applies to `getProjectionMatrix` (line 70) and `getViewProjectionMatrix` (must exist nearby; locate by grep).

5. For `mat4PerspectiveLHToRef(camera._projCache, ...)` on line 78: this is a kernel call. Task 1.1 widened the kernel parameter to `Mat4Storage`. The call site continues to work after `_projCache` is widened to `Mat4`.

6. For lights (`directional-light.ts`, `hemispheric.ts`, `spot-light.ts`): the `_localMatrix` is currently created at light-construction time. Move to lazy or rebindable. The simplest pattern matches the camera case: declare `_localMatrix: Mat4 | null = null` on the light's internal state, allocate on first access through the bound policy, and add `_rebindAllocator(alloc)` that re-allocates and invalidates any version cache the light tracks.

7. For shadow generators: replace each `new Float32Array(16)` (lines 125, 140, 112, 145 across `shadow-base.ts`, `shadow-generator.ts`, `pcf-shadow-generator.ts`, `pcf-directional-shadow-generator.ts`) with allocation via the bound policy. ShadowGenerator's `_boundPolicy` is set in `bindEntityMatrixPolicy` (Task 2.2). For the per-frame `proj` matrices, lazy-init once per shadow generator and reuse — these are not per-frame allocations today, so no GC risk.

8. **glTF parser scratch** (`gltf-parser.ts:152,164`, `gltf-animation.ts:95`, `gltf-feature-gpu-instancing.ts:158`): these are addressed in Task 2.4 (it's a larger refactor). Leave as-is for this task, with a `// TODO(M0/02_04): allocate via scene policy` comment.

9. Run a grep at the end: `Select-String -Path .\packages\babylon-lite\src -Pattern 'new Float32Array\(16\)' -Recurse`. After this task, the remaining hits should be:
    - The kernel allocators in `math/mat4-*.ts` (intentional — see Background; they return-by-value scratch).
    - The four glTF files (TODO for Task 2.4).
    - `loader-skybox/load-skybox.ts:39`, `picking/gpu-picker.ts:16`, `mesh/gaussian-splatting-mesh.ts:158`, `material/pbr/background-*.ts` — explicitly deferred per architecture D4 (out of M0 scope).
    - F32 scratch allocations that are GPU upload views (`shadow/shadow-base.ts:125` if the buffer is the upload view; verify).

   Any other hit must be migrated to allocator-driven creation in this task.

## Testing suggestions

- New unit test `tests/unit/matrix-cache-storage.test.ts`:
    - Create engine with `useHighPrecisionMatrix: true` + scene + mesh + attach.
    - Read `mesh.worldMatrix` (forces world-matrix-state to compute) — assert the underlying storage is `Float64Array` via `asMat4Storage(mesh.worldMatrix) instanceof Float64Array`.
    - Same for camera `_viewCache` / `_projCache` after a `getViewMatrix` / `getProjectionMatrix` call.
    - Same for a directional light's `_localMatrix` after the light's `getWorldMatrix` (or equivalent) is called.
    - Repeat with HPM off — assert all storage is `Float32Array`.
- `pnpm test:parity` — MUST be green. With HPM off (default) every existing scene should produce bit-identical output. With HPM on, no parity scene currently triggers the case (the new dedicated parity scene is Task 4.3), so values stay within MAD tolerance.
- `pnpm exec vitest run` — green; verify the existing tests in `tests/unit/sprite-renderer.test.ts`, `tests/unit/sprite-depth-hosted-routing.test.ts`, etc. still pass.

## Gotchas

- The biggest trap is that **`_viewCache`, `_projCache`, `_vpCache` are typed `Float32Array` on the public-ish `Camera` interface**. Widening them to `Mat4` is a breaking change inside the engine. Audit every consumer of `camera._viewCache` etc. — likely in `frame-graph/render-task.ts`, `shadow/shadow-base.ts`, `picking/`. Use `asMat4Storage` at consumer sites where they need typed-array indexing.
- Because GPU upload paths (Phase 3) will read the cache as a `Mat4` and pack it via `packMat4IntoF32`, no consumer should be doing `device.queue.writeBuffer(..., cache)` directly on the cache itself after Phase 3. In this task, leave the existing direct-write paths intact (Phase 3 rewires them); they will keep working as long as the allocator returns `Float32Array` for HPM-off. They will produce silent type errors for HPM-on if uncasted; tag those sites with `// TODO(M0/03_*)` so Phase 3 cleans them up.
- `mat4PerspectiveLHToRef` already accepts `Mat4Storage` after Task 1.1. Calls like `mat4PerspectiveLHToRef(camera._projCache, ...)` work after the widening. If you find a site that has not been widened, fix it.
- Do not allocate per frame. Lazy-init once per cache, then reuse. Per-frame allocation in hot paths is a GC pressure regression that `tests/bundle-size.test.ts` won't catch but `pnpm test:perf` (user-only) will.
- Do not change kernel allocator behavior in `mat4-identity.ts`, `mat4-compose.ts`, `mat4-from-quat.ts`, etc. They are general-purpose helpers used outside the engine policy context; they continue to return F32 scratch.
- The bind helper from Task 2.2 must call `_rebindAllocator?.(policy.allocator)` AFTER setting `_boundPolicy` so the cache reset has the new policy reference. Reorder if needed.

## Verification checklist

- [ ] `world-matrix-state.ts` exposes `_rebindAllocator(alloc)` on `WorldMatrixAccessors` and uses `let _ownedWorld` re-bindable storage.
- [ ] Camera `_viewCache` / `_projCache` / `_vpCache` allocate via `camera._boundPolicy.allocator` after attach.
- [ ] Directional, hemispheric, and spot lights allocate `_localMatrix` via their bound policy.
- [ ] Free camera `_localMat` allocates via bound policy.
- [ ] Shadow generators (`shadow-generator.ts`, `pcf-shadow-generator.ts`, `pcf-directional-shadow-generator.ts`) allocate `proj` matrices via bound policy.
- [ ] `bindEntityMatrixPolicy` invokes `_rebindAllocator` on every matrix-owning entity it binds.
- [ ] New unit test `tests/unit/matrix-cache-storage.test.ts` confirms F64 storage with HPM on, F32 with HPM off.
- [ ] No surviving `new Float32Array(16)` outside the documented exceptions list (kernel scratch returns + Task 2.4 glTF + deferred uploaders).
- [ ] `pnpm test:parity` is green; `pnpm exec vitest run` is green; `pnpm exec tsc --noEmit` is clean.
