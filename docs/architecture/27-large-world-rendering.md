# Large World Rendering / `useFloatingOrigin`

Porting plan for BJS 9.0's "Large World Rendering" / floating-origin feature
(authored upstream by @georgie). See companion doc
[`28-geospatial-camera.md`](./28-geospatial-camera.md) — the two features are
orthogonal but compose well (a Geospatial scene rendered at 1:1 meters
needs floating origin to avoid float32 jitter).

## References

- Upstream impl: `packages/dev/core/src/Materials/floatingOriginMatrixOverrides.ts`
- Upstream wiring: `scene.ts:2035-2038, 1255-1280, 2898-2905`
- BJS PR: [#17334](https://github.com/BabylonJS/Babylon.js/pull/17334)
- Forum announcement: [t/61114](https://forum.babylonjs.com/t/61114)
- BJS doc: <https://doc.babylonjs.com/features/featuresDeepDive/scene/large_world>
- BJS unit test: `packages/dev/core/test/unit/Meshes/babylon.instancedMesh.lwr.test.ts`
- BJS visual test fixture: `packages/tools/tests/test/visualization/config.json` (entry "Havok FloatingOrigin Multi-Region", PG `#ND10JJ#0`)
- Lite baseline: `packages/babylon-lite/src/scene/scene-camera.ts`, `scene/scene.ts`, mesh world-matrix uploaders

## Design notes (Lite-shaped)

BJS achieves LWR with two cooperating mechanisms:
1. **CPU**: swap `Matrix` storage from Float32Array to Float64Array engine-wide
   (`useHighPrecisionMatrix`). This is what keeps precision alive across
   parent-chain composition, picking inverses, world-space culling/LOD, and
   any other CPU code path that touches absolute world coordinates.
2. **GPU**: monkey-patch `Effect.prototype.setMatrix` and
   `UniformBuffer.prototype._updateMatrixForUniform` to subtract
   `scene._eyePosition` from `world` translation, zero `view` translation,
   and decompose/recompose `worldView`/`viewProjection`/`worldViewProjection`.
   Plus direct offsets on lights, sprites, particles, clip planes, instance
   buffers, shadow generators, and the eye-position uniform.

These two mechanisms are **not independent** — the GPU offset trick relies on
having precision-preserving world matrices feeding into it. Subtracting an
F64-accurate eye offset from an already-F32-degraded world translation
recovers nothing; the low bits were lost upstream. So the CPU substrate is a
prerequisite for the GPU pass to actually deliver precision.

In Lite this maps to:
- Lite has no `Matrix` class — math is on a branded `Float32Array` `Mat4`
  type (`math/types.ts`). The high-precision step becomes a dual-precision
  mat4 layer: `Mat4` widens to accept F32 or F64 backing, every mat4 op gains
  an F64-capable path, and the GPU upload boundary becomes the single place
  we downcast. Exposed via an engine option `useHighPrecisionMatrix` that
  mirrors the BJS API surface (so BJS apps that depend on the flag can
  migrate without rewriting their precision strategy).
- Lite has no `Effect`/`UniformBuffer` global with mutable prototypes. Instead,
  the offset path lives in the central upload path
  (`scene-camera.ts` for view/proj, mesh world matrix uploaders, light UBO
  builders, etc.). We add one helper module
  (`large-world/floating-origin.ts`) and call into it explicitly from each
  uploader. **Tree-shakable**: scenes that don't enable LWR import nothing
  from this module and pay zero bundle cost (per `sideEffects: false`).
- Public API: three flags, mirroring the BJS surface.
  - `useHighPrecisionMatrix` on the engine constructor — engine-wide CPU
    precision substrate, usable standalone for migrants who relied on it in
    BJS without LWR (e.g., deep node hierarchies at moderate but non-trivial
    coordinates).
  - `useFloatingOrigin` on `createSceneContext` — per-scene GPU offset trick.
    **Requires** `useHighPrecisionMatrix: true` on the engine; validated at
    scene creation with a clear error.
  - `useLargeWorldRendering` on the engine constructor — convenience that
    forces `useHighPrecisionMatrix: true` and makes `useFloatingOrigin: true`
    the **default** for scenes created on this engine. Per-scene
    `useFloatingOrigin: false` still wins (so UI/HUD overlay scenes on an
    LWR engine can opt out and stay in pure rendering mode).
  - Plus `scene.floatingOriginOffset` read-only getter for app code that
    needs to know the current offset (e.g., for world-space queries).
- Multi-scene composition: scenes are independent `RenderingContext`s. An
  LWR-enabled 3D scene and a non-LWR UI overlay scene can coexist on the
  same engine — the engine-wide F64 substrate covers both (small overhead
  for the UI scene's matrices, no correctness issue), and only scenes with
  `useFloatingOrigin: true` perform the offset trick at upload.

Milestones below are **feature-oriented** — each milestone is independently
shippable and lands with the tests that validate what it added. No standalone
"tests" milestone.

## Milestone 0 — Dual-precision mat4 layer (`useHighPrecisionMatrix`)

Foundation for everything that follows. Ships **on its own** as a standalone
feature — BJS migrants who use `useHighPrecisionMatrix` without LWR get value
from this milestone immediately, and LWR builds on top of it.

Today the `useHighPrecisionMatrix` field on `EngineOptions` /
`EngineInternal` is dead plumbing (BJS-skeleton stub, never read). This
milestone makes it real.

- **m0-mat4-dual-precision**: Widen `Mat4` in `math/types.ts` to accept
  Float32 or Float64 backing (branded variants `Mat4F32`, `Mat4F64`, with
  `Mat4` as the union). Add F64-capable variants of every mat4 op currently
  in `math/`: `mat4Multiply`, `mat4Invert`, `mat4LookAtLH`, `mat4Compose`,
  `mat4FromQuat`, `mat4Identity`, `mat4Scale`, `mat4Translation`,
  `mat4MultiplyInto`, `mat4ComposeInto`, `mat4PerspectiveLH`,
  `mat4PerspectiveLHToRef`. Prefer generic dispatch on the view type over
  duplicated kernels where the JIT will optimize it cleanly; benchmark to
  confirm.
- **m0-engine-flag**: Wire `EngineOptions.useHighPrecisionMatrix` through to
  `EngineInternal` (already plumbed structurally — make it functional). When
  `true`, all mat4 allocations on the CPU side use F64 backing.
- **m0-upload-boundary**: Establish the GPU upload boundary as the single
  place where F64 → F32 downcast happens. Audit every mat4 → GPU buffer
  write site (mesh world UBO, view/proj UBO, light UBOs, thin-instance
  buffer, shadow matrices) and route through a single
  `writeMat4ToBuffer(view, mat)` helper that downcasts when input is F64.
- **m0-world-space-reads**: Audit CPU-side world-space readers (picking,
  frustum cull, AABB tests, distance-based LOD, `getCameraPosition` calls
  that feed app logic) to use the F64 storage directly when the flag is on
  rather than downcasting first.

_Validation_:
- Pure-math unit tests: round-trip a chain of multiplies / inverts at
  large coordinates (camera + parent chain ~1e6) and verify F64 mode
  preserves sub-unit precision where F32 mode drifts. Mirror relevant
  cases from `babylon.instancedMesh.lwr.test.ts`.
- Parity scene at moderate-but-non-trivial coordinates (~1e5) with a deep
  node hierarchy and visible jitter under F32; F64 mode eliminates the
  jitter. Capture BJS golden with `useHighPrecisionMatrix: true` for ref.
- Bundle-size: no scene's bundle-size ceiling is raised by this milestone.
  Dual-precision paths add some bytes to scenes that already pull in mat4
  ops; the F64-only specialized variants must be tree-shaken when only
  the F32 path is reachable. Exact bundle deltas are a requirements-phase
  decision, not a goal of zero.
- `pnpm test` (build + parity) green. No `test:perf`.

## Milestone 1 — Floating-origin plumbing + mesh/view rendering path

Depends on M0. With the dual-precision layer in place, floating-origin
becomes "subtract the eye offset on the F64 side, then downcast at upload"
— a clean overlay on the existing precision substrate.

**Scope shipped in M1 (commits LWR M1.1–M1.5 + simplification `07be57e`):**

- **a1-types**: Add `useFloatingOrigin?: boolean` to `SceneContextOptions` and
  a `_floatingOriginOffset: Vec3` (mutable by-reference array, default
  `[0,0,0]`) on `SceneContextInternal`. The `Camera` interface gains
  `_floatingOriginOffset?: readonly [number, number, number] | null` — the
  scene's `_update` wires `camera._floatingOriginOffset = scene._floatingOriginOffset`
  (idempotent reference assignment) so `getViewMatrix` reads the offset
  directly from the camera. No scene reference needed on the camera
  (preserves one-way ownership, pillar 4b).
- **a1-validate-precondition**: At `createSceneContext` time, throw a clear
  error if `useFloatingOrigin: true` is set on an engine that wasn't created
  with `useHighPrecisionMatrix: true`.
- **a1-pack-helper**: Add `packMat4IntoF32WithOffset(dst, src, dstOffset,
  foOffset)` next to `packMat4IntoF32`. When `foOffset` is `[0,0,0]` the
  result is bit-identical to `packMat4IntoF32`; otherwise it subtracts
  `foOffset` from the translation column `[12..14]` while downcasting F64
  → F32. Used for mesh-WORLD matrices only.
- **a1-world-matrix-upload**: Route every mesh-world-matrix UBO write through
  `packMat4IntoF32WithOffset`:
  - `material/standard/standard-renderable.ts` (build + per-frame update)
  - `material/pbr/pbr-renderable.ts` (build + per-frame update)
  - `material/node/node-renderable.ts` (build + per-packet update)
  - Intentionally LEFT on plain `packMat4IntoF32` (precision-only):
    `mesh/thin-instance-gpu.ts` (thin-instances are mesh-local, not world),
    and `render-task.ts` view/viewProj uploads (see next bullet).
- **a1-view-baked-offset**: Bake the floating-origin offset into the view
  matrix at *construction* time, NOT at upload time. `getViewMatrix` reads
  `camera._floatingOriginOffset` and subtracts it from the camera world
  position BEFORE computing `R_inv * -cameraPos`. When `offset ==
  cameraPos`, the resulting translation column is mathematically zero. The
  view + viewProj uploads in `frame-graph/render-task.ts` therefore stay on
  the precision-only `packMat4IntoF32` helper — a second subtraction at
  upload would double-bias the translation.
- **a1-eye-position-uniform**: `writePassSceneUBO` writes
  `camera.worldMatrix[12..14] - scene._floatingOriginOffset[0..2]` for
  `vEyePosition`. Shader expressions of the form
  `scene.vEyePosition.xyz - input.worldPos` now produce the eye-relative
  vector at full precision because both sides live in the small-magnitude
  eye-relative frame.
- **a1-camera-offset-wire**: `scene-core._update` does a single reference-
  identity check + assignment: if `ctx.camera._floatingOriginOffset !== ctx._floatingOriginOffset`,
  wire it. Idempotent for a stationary `scene.camera`; auto re-wires if
  the camera is reassigned. Zero staleness possible.

_Validation (M1 acceptance gate)_:

- Pure-math unit tests for `packMat4IntoF32WithOffset` (zero-offset
  identity, non-zero translation subtraction, F64 source → F32 dst).
- Integration test: `scene200` (HPM off, FO off baseline) vs `scene201`
  (HPM on, FO on, camera + meshes at 1e6) MUST diverge with MAD ≥ 5.0,
  proving the offset path is engaged and meaningfully shifts pixels.
  Both Lite-only scenes (no BJS golden yet — the parity scene with
  golden is M2 scope).

## Milestone 2 — Thin-instances + LWR engine convenience flag + golden parity

Builds on M1's per-mesh path. M1 already handles the 80% case for
ordinary meshes; M2 finishes the rendering coverage and lands the first
golden-validated parity scene.

- **a2-thin-instances**: In `setThinInstances` upload path, subtract offset
  from translation columns (F64 source → F32 GPU). M1 deliberately left
  thin-instance matrices on the precision-only packer because they are
  *mesh-local*, not world-space — but a thin-instance hierarchy whose
  PARENT mesh is at ECEF-scale still needs the offset applied to the
  parent's world matrix (already covered in M1) plus the local instance
  packed in mesh-local space. This item only adds work if Lite grows
  scenes whose instance matrices themselves carry world translations.
- **a2-double-offset-guard**: Audit the upload chain for any path that
  could subtract the offset twice (e.g. a pre-composed `worldView` whose
  `world` was already offset-packed AND whose `view` was already
  offset-baked). Today there is no such path — every upload site either
  packs `world` with offset, OR uploads `view` whose offset was baked in
  at construction (per a1-view-baked-offset), never both. Add a sanity
  assertion in dev builds if/when a new upload path is introduced that
  composes the two.
- **a2-engine-convenience**: Add `useLargeWorldRendering?: boolean` to
  `EngineOptions`. When `true`:
  - Force `useHighPrecisionMatrix: true` on the engine (throw if the user
    explicitly passed `useHighPrecisionMatrix: false` alongside it — that's
    a contradiction, not a silent override).
  - Set an engine-internal `_floatingOriginDefault = true` so
    `createSceneContext` without an explicit `useFloatingOrigin` opts in.
  - Per-scene `useFloatingOrigin: false` still wins (UI/HUD overlay scenes
    on an LWR engine opt out cleanly).
  This is the form most BJS apps actually use; landing it alongside the
  underlying flags keeps the migration story complete.

_Validation_:

- Author Lite scene `lab/sceneN.html` and BJS ref `lab/babylon-ref-sceneN.html`
  at ECEF-scale coordinates (camera at ~1e6, mesh chain showing sub-unit
  precision survival). Mirror PG `#5U0N0Q` or `#P3E9YP#256`.
- Capture BJS golden to `reference/sceneN-large-world/babylon-ref-golden.png`
  (with explicit user approval).
- Add `tests/parity/scenes/sceneN-large-world.spec.ts` with `maxMad` ceiling.
- Add bundle-size ceiling in `scene-config.json` /
  `tests/parity/bundle-size.spec.ts`; verify scenes that don't import the
  LWR module pay zero bytes.
- `pnpm test` (build + parity) green. No `test:perf`.

## Milestone 3 — Lighting & shadows

- **a3-light-positions**: Subtract offset from point/spot light positions in
  the light UBO builder (`light/` modules).
- **a3-shadow-eyeAtCamera**: Add the `eyeAtCamera` flag pattern — when
  rendering the shadow camera's view, take the *full* offset path (don't
  zero view translation, since the shadow "camera" is the light, not the
  active camera).
- **a3-shadow-light-matrix**: Offset `lightMatrix` and `lightDataSM`
  uniforms in shadow uploads.
- **a3-pcf-csm-parity**: Verify both `createShadowGenerator` and
  `createPcfShadowGenerator` paths in Lite work correctly. CSM is not yet
  in Lite per `docs/porting-guide.md`; flag as out-of-scope.

_Validation_: Add a shadowed parity scene at ECEF scale (point/spot light +
PCF shadows on the mesh chain) with golden + parity spec, OR extend the
Milestone 2 scene with shadows if cheaper.

## Milestone 4 — Auxiliary rendering paths

Port only what Lite actually has — verify each before scoping. Each item that
lands extends parity coverage as applicable.

- **a4-clip-planes**: `d' = d + dot(normal, offset)` in clip plane upload
  (only if Lite has clip plane support — verify).
- **a4-sprites**: If `sprite/` module is in scope, offset vertex positions
  on emit.
- **a4-particles**: Same for any CPU/GPU particle systems Lite ships.
- **a4-skybox-environment**: Verify `loadEnvironment`'s skybox path is
  unaffected (skybox uses view rotation only, no translation). Bug-fix if
  needed.
- **a4-background-material**: If Lite has a `BackgroundMaterial` analog,
  offset `vBackgroundCenter`.

_Validation_: For each path that ships, extend an existing LWR parity scene
(or add a small focused one) so the offset is exercised on the GPU.

## Milestone 5 — Optional / later

Defer until concrete demand. Each item, when picked up, lands with its own
parity coverage.

- Havok multi-region floating origin (`floatingOriginWorldRadius`,
  `_checkAndMigrateBody`, per-region gravity). Substantial — defer until
  a real demand from a Lite physics scene appears.
- Atmosphere addon "world origin = planet center" special case.
- NME / NodeMaterial parity.

## Out of scope (don't port)

- BJS prototype monkey-patching. Lite's centralized upload path is cleaner.

## Cross-cutting conventions

- **Tree-shaking**: Module must be importable a la carte. No module-level
  `Map`/`Set`/`WeakMap` allocations. Lazy-init any caches.
- **Pure-state handles + standalone functions**: No classes, no methods.
  Every scene operation is a free function over plain data.
- **No bundle-size ceiling raises** without explicit user approval.
- **No golden-reference changes** without explicit user approval.
- **Validate via `pnpm test`** (build:bundle-scenes + parity). **Never run
  `pnpm test:perf`** — perf is user/CI only.
- **Iteration tip**: during dev on a single new scene, run
  `npx playwright test tests/parity/scenes/<scene>.spec.ts` for fast
  feedback; full `pnpm test` before declaring success.
