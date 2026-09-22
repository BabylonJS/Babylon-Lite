# Inspector Material and Texture Parity Implementation Plan

> Feature: `inspector-material-texture-parity` (P4 of BabylonJS/Babylon-Lite issue #55)  
> Inputs: approved `goals.md`, `requirements.md`, `architecture.md`, and `task-board.md` in this directory  
> Status: completed, followed by an approved pre-landing API correction
> Scope of this artifact: implementation sequencing only; do not update `task-board.md` until a separately approved execution phase

## Post-Implementation API Correction

T-01–T-29 below accurately record the originally approved implementation. API review then approved a pre-landing correction that removes Lite-owned Inspector descriptors and dispatchers while preserving the completed Inspector behavior as adapter responsibility.

The correction:

1. Deletes `packages/babylon-lite/src/inspection/`.
2. Root-exports domain getters for material source, optional Standard/PBR state, Shader declarations/values, and safe texture metadata/transforms. Stored configuration objects, tuples, uniform arrays, and texture wrappers are returned by identity through readonly TypeScript contracts rather than defensive copies or runtime freezing. Texture metadata uses only observable wrapper/GPU facts and never device-recovery sources; unknown provenance and opaque sampler descriptors remain omitted.
3. Rewrites `getMaterialTextures()` directly from material family state, preserving MaterialView unwrapping, duplicates, and legacy family ordering without extension registries.
4. Keeps existing setters plus `markMaterialUboDirty`, `enableMaterialUvTransform`, and `rebuildMaterial`; Inspector performs consumer discovery and invalidation planning. `rebuildMaterial` exposes its conditional `void | Promise<void>` completion directly and does not consume asynchronous failures internally.
5. Replaces descriptor/mutation tests with `material-accessors`, `texture-accessors`, material-family compatibility, public declaration, and domain tree-shaking coverage.

Corrected focused Lite validation uses:

```bash
pnpm exec vitest run --project unit \
  tests/lite/unit/material-accessors.test.ts \
  tests/lite/unit/material-family.test.ts \
  tests/lite/unit/texture-accessors.test.ts \
  tests/lite/unit/runtime-material-rebuild.test.ts
pnpm exec vitest run --project build \
  tests/lite/build/public-api-types.test.ts \
  tests/lite/build/domain-accessor-treeshake.test.ts
pnpm exec tsc -p packages/babylon-lite/tsconfig.json --noEmit
pnpm exec tsc -p tests/lite/tsconfig.json --noEmit
pnpm build:lib
pnpm exec tsx scripts/build-bundle-scenes.ts --scenes scene1,scene26,scene28
```

The historical public API and task details below are non-normative where they conflict with this correction.

## 1. Outcome and Non-Negotiable Boundaries

This plan delivers the approved root-public Babylon Lite inspection/mutation contracts and the Inspector v2 material and metadata-only texture experience for Standard, PBR, Shader, and Node materials. The implementation is split between the Babylon-Lite repository and the Babylon.js Inspector v2 repository. The repositories may progress in parallel until the Lite adapters need the new `@babylonjs/lite` API.

The implementation MUST preserve these approved decisions:

1. `getMaterialTextures()` remains a flat non-null `Texture2D[]`; named binding discovery is its new canonical source and Standard cube reflection is excluded from the legacy projection.
2. Existing public mutation directions are authoritative. P4 adds no clear/unset API merely to make an Inspector control symmetric.
3. PBR lightmap and metallic-reflectance bindings never advertise unsupported clear operations.
4. One-way PBR unlit/tint, gamma-albedo, skybox, and shadow-only modes are displayed read-only; P4 adds no reversible setter.
5. Standard `CubeTexture` reflection is discoverable, selectable, navigable, and metadata-only.
6. Runtime-neutral preview/editor extraction and every Lite preview, pixel-edit, resize, reset, upload, save, and export action are deferred entirely to P11b. P4 does not modify the existing Babylon.js preview/editor components.
7. All Lite exports come from the package root, expose no raw WebGPU handle, add no entity-to-scene back-reference, and introduce no module-evaluation registration or eager collection.
8. Visual/parity tests, all-scene tests, performance tests, golden changes, and bundle-ceiling changes are not part of local P4 execution.

Changing a public signature, U/R/A classification, binding direction, lazy-load boundary, or any decision above requires architecture re-approval.

## 2. Normative Public API Additions

Implementation must use the exact signatures and unions in `architecture.md` §4. The root entry `packages/babylon-lite/src/index.ts` will export:

- Capability/value types: `InspectionValue`, `InspectionDatum`, `InspectionNumberConstraint`, `MaterialMutationClass`, `AppliedMaterialMutationClass`, `MaterialPostMutation`, `MaterialInspectionEdit`, `MaterialInspectionReadOnly`, and `MaterialInspectionAccess`.
- Material snapshot types: `MaterialInspectionSection`, `MaterialInspectionScalar`, `MaterialInspectionTuple`, `MaterialInspectionPropertyValue`, `MaterialInspectionPropertyId`, `MaterialInspectionProperty`, and `MaterialInspection`.
- Binding types: `TextureInspectionKind`, `TextureBindingKind`, `TextureSampleCategory`, `TextureViewCategory`, `TextureBindingDirection`, `MaterialTextureBindingId`, `MaterialInspectionTextureReference`, and `MaterialTextureBinding`.
- Texture metadata types: `TextureInspectionOrigin`, `TextureColorSpace`, `TextureAddressMode`, `TextureFilterMode`, `TextureInspectionTransform`, `TextureSamplerInspection`, and `TextureInspection`.
- Mutation types: `MaterialInspectionMutationScope`, `MaterialTextureMutation`, and `MaterialInspectionMutationResult`.
- Pure functions:
    - `inspectMaterial(material: Material): MaterialInspection`
    - `getMaterialTextureBindings(material: Material): readonly MaterialTextureBinding[]`
    - `inspectTexture(texture: unknown): TextureInspection | undefined`
    - `setMaterialInspectionProperty(scope, material, property, value): Promise<MaterialInspectionMutationResult>`
    - `setMaterialInspectionTexture(scope, material, binding, mutation): Promise<MaterialInspectionMutationResult>`
    - `setTextureInspectionTransform(scope, texture, transform): Promise<MaterialInspectionMutationResult>`
- Additive rebuild API:
    - `AwaitedRebuildMaterialOptions extends RebuildMaterialOptions` with `awaitCompletion: true`
    - `rebuildMaterial(scene, materialOrView, options: AwaitedRebuildMaterialOptions): Promise<void>`
    - Preserve the existing `void` overload and fire-and-report behavior.

No package export other than `"."` is added.

## 3. Execution Graph

### 3.1 Phase and task count

| Phase     | Focus                                                   |        Tasks |
| --------- | ------------------------------------------------------- | -----------: |
| P0        | Contract and regression harness                         |          T01 |
| P1        | Lite public foundation and awaited rebuild              |      T02–T04 |
| P2        | Lite family inspection, binding, metadata, and mutation |      T05–T11 |
| P3        | Inspector Lite resource index, discovery, and refresh   |      T12–T14 |
| P4        | Runtime-neutral shared components                       |      T15–T17 |
| P5        | Babylon.js adapters and regression preservation         |      T18–T19 |
| P6        | Lite material/texture adapters and lifecycle            |      T20–T22 |
| P7        | Cross-layer verification, isolation, and size           |      T23–T24 |
| **Total** | **8 phases**                                            | **24 tasks** |

### 3.2 Key dependency chain

```text
T01
 ├─ T02 ─ T04 ─┬─ T05 ─┐
 │             ├─ T06 ─ T07 ─┐
 │             ├─ T08 ───────┤
 │             └─ T09 ───────┴─ T10 ─ T11 ─ T12 ─ T13 ─ T14 ─┐
 └─ T03 ────────────────────────────────┘                       │
                                                               ├─ T20 ─ T22 ─ T23 ─ T24
T01 ─ T15 ─ T16 ─ T17 ─ T18 ─ T19 ─────────────────────────────┘
                                      T12 ───────────────── T21 ┘
```

Safe parallelism:

- T02 and T03 can proceed independently after T01.
- T05, T06, T08, and T09 can proceed in parallel after T04 if each lane edits only its family module/test; T10 alone wires the shared dispatcher and legacy projection to avoid merge conflicts. T07 follows T06.
- T12–T14 and T15–T19 can proceed in separate repositories in parallel once the public API shape is frozen.
- T18 and T19 can proceed in parallel after T17.
- T20 and T21 can proceed in parallel after T12, T17, and the relevant Lite APIs exist. T22 integrates their operation state.
- T23 and T24 are convergence gates and do not run until all preceding implementation tasks are green.

### 3.3 Cross-repository landing order

1. Land or publish the Babylon-Lite public API and contract tests from T02–T11.
2. Land the runtime-neutral shared cores and Babylon.js adapters from T15–T19; these do not depend on Lite runtime code.
3. Update the Babylon.js workspace `@babylonjs/lite` dependency or use the repository's approved local package-link workflow, then land T12–T14 and T20–T22.
4. Land T23–T24 only after both entries compile and package-isolation checks pass.

Each task below is a commit-sized slice. Tasks marked **independent** can land separately without exposing partial end-user behavior; **stacked** tasks should remain in the feature branch until their listed dependency closes the public behavior.

## 4. Focused Validation Commands

These are the only planned local validation families. Commands must be narrowed further to the files touched by a slice when possible.

### Babylon-Lite repository

```bash
# L-UNIT-MATERIAL
pnpm exec vitest run --project unit \
  tests/lite/unit/material-inspection.test.ts \
  tests/lite/unit/standard-material-inspection.test.ts \
  tests/lite/unit/pbr-material-inspection.test.ts \
  tests/lite/unit/shader-material-inspection.test.ts \
  tests/lite/unit/node-material-inspection.test.ts \
  tests/lite/unit/material-family.test.ts

# L-UNIT-TEXTURE
pnpm exec vitest run --project unit \
  tests/lite/unit/texture-inspection.test.ts \
  tests/lite/unit/inspection-mutation.test.ts

# L-UNIT-REBUILD
pnpm exec vitest run --project unit tests/lite/unit/runtime-material-rebuild.test.ts

# L-PUBLIC-API
pnpm exec vitest run --project build tests/lite/build/public-api-types.test.ts

# L-TREESHAKE
pnpm exec vitest run --project build \
  tests/lite/build/inspection-treeshake.test.ts \
  tests/lite/build/treeshake-rollup.test.ts

# L-TYPE
pnpm exec tsc -p packages/babylon-lite/tsconfig.json --noEmit
pnpm exec tsc -p tests/lite/tsconfig.json --noEmit

# L-FINAL-STYLE (mandatory after code changes)
pnpm run lint:fix
pnpm run lint

# L-FILTERED-SIZE (runtime-byte check only; no visual/parity execution)
pnpm build:lib
pnpm exec tsx scripts/build-bundle-scenes.ts --scenes scene1,scene26,scene28
```

`scene1` provides a representative ordinary non-Inspector PBR application; `scene26` and `scene28` exercise optional subsurface and clear-coat loading. Their runtime-loaded byte totals and fetched chunk graphs must not grow because inspection exports are unused. No ceiling is changed if any command fails.

### Babylon.js repository

```bash
# I-SHARED
npm test -w @dev/inspector -- \
  test/unit/runtimeNeutralPropertyLines.test.tsx \
  test/unit/materialTextureAdapterContracts.test.tsx

# I-EXPLORER
npm test -w @dev/inspector -- test/unit/liteExplorerServices.test.ts

# I-PROPERTIES
npm test -w @dev/inspector -- \
  test/unit/litePropertiesServices.test.tsx \
  test/unit/materialTextureAdapterContracts.test.tsx

# I-BOUNDARIES
npm test -w @dev/inspector -- test/unit/p4ImportBoundaries.test.ts

# I-COMPILE
npm run compile -w @dev/shared-ui-components
npm run compile -w @dev/inspector

# I-LINT
npm run lint:changed
```

Do not run Babylon-Lite `pnpm test`, full `pnpm test:parity`, unfiltered `pnpm build:bundle-scenes`, visual tests, performance tests, or any golden-update command.

## 5. Ordered Implementation Tasks

### P0 — Contract and Regression Harness

#### T01 — Freeze public and import-boundary tests

- **Depends on:** approved architecture only.
- **Repository/files:**
    - Modify `tests/lite/build/public-api-types.test.ts`.
    - Add `tests/lite/build/inspection-treeshake.test.ts`.
    - Add Babylon.js `packages/dev/inspector-v2/test/unit/p4ImportBoundaries.test.ts`.
- **Work:**
    - Add compile/declaration expectations for every public symbol in §2, exact overload return types, root-only import use, `MaterialView` acceptance, and `object`-typed texture references.
    - Assert the rolled declaration exposes no raw WebGPU type through any new inspection result and strips package-private translator members.
    - Add static dependency assertions that shared P4 cores import neither runtime, the Babylon.js entry imports no Lite code, the Lite entry imports no Babylon.js material/texture implementation, and no P4 module imports preview/editor/debug tooling.
    - Establish an unused-import Rollup comparison: importing but not consuming inspection exports must emit the same code as the baseline non-Inspector entry.
- **Requirements:** REQ-SCOPE-5–6, REQ-ADAPT-6–8, REQ-ADAPT-10, REQ-SIZE-1–5, REQ-TEST-6, REQ-TEST-8–9.
- **Acceptance evidence:** the new tests initially fail only for missing P4 symbols/modules; existing root-export and side-effect assertions remain unchanged. Run `L-PUBLIC-API`, `L-TREESHAKE`, and `I-BOUNDARIES` as their implementations become available.
- **Tree-shaking checkpoint:** record the baseline Rollup output and filtered-scene manifests without altering ceilings or generated files.
- **Slice:** `test(inspector): define P4 contract and isolation guards` — **stacked test-first** slice; keep it with the first green implementation slices rather than landing red tests alone.

### P1 — Lite Public Foundation and Awaited Rebuild

#### T02 — Add pure inspection value and capability types

- **Depends on:** T01.
- **Repository/files:**
    - Add `packages/babylon-lite/src/inspection/inspection-types.ts`.
    - Modify `packages/babylon-lite/src/index.ts`.
    - Add `tests/lite/unit/material-inspection.test.ts` for discriminated-value and unknown-family basics.
- **Work:**
    - Implement the exact immutable unions/interfaces from architecture §§4.1–4.5.
    - Keep values limited to primitives, readonly tuples/records, existing Lite entity references, and opaque `object` identity.
    - Export only from the root; do not alter `packages/babylon-lite/package.json`.
- **Requirements:** REQ-SCOPE-4–6, REQ-API-1–2, REQ-API-4–5, REQ-API-7–8, REQ-SIZE-2.
- **Acceptance evidence:** type probes can distinguish unsupported/absent/present and unknown/known without truthiness; no GPU handle is assignable from a snapshot. Run the T02 test, `L-PUBLIC-API`, and `L-TYPE`.
- **Tree-shaking checkpoint:** the type module must erase completely; `inspection-treeshake.test.ts` remains byte-identical.
- **Slice:** `feat(inspector): add pure Lite inspection types` — **independent/additive**.

#### T03 — Make material rebuild completion awaitable

- **Depends on:** T01; may run parallel to T02.
- **Repository/files:**
    - Modify `packages/babylon-lite/src/material/material-rebuild.ts`.
    - Modify `packages/babylon-lite/src/index.ts`.
    - Modify `tests/lite/unit/runtime-material-rebuild.test.ts`.
- **Work:**
    - Add `AwaitedRebuildMaterialOptions` and the Promise overload without duplicating the rebuild algorithm.
    - Await mesh/view rebuilds and optional frame-graph rebuild, resolve after completion, and reject through the awaited path.
    - Preserve the existing overload's synchronous return and current runtime-hook/`console.error` reporting.
- **Requirements:** REQ-MUT-3, REQ-MUT-8, REQ-MUT-10, REQ-REFRESH-5, REQ-TEST-3.
- **Acceptance evidence:** tests prove overload typing, completion ordering, view rebuilding, optional frame-graph rebuilding, rejection for awaited failures, and unchanged legacy reporting. Run `L-UNIT-REBUILD`, `L-PUBLIC-API`, and `L-TYPE`.
- **Tree-shaking checkpoint:** no module state or registry; an unused awaited branch retains zero code beyond the existing rebuild export.
- **Slice:** `feat(material): add awaitable material rebuild` — **independent/additive**.

#### T04 — Implement common material inspection and transaction primitives

- **Depends on:** T02 and T03.
- **Repository/files:**
    - Add `packages/babylon-lite/src/inspection/material-inspection.ts`.
    - Modify `packages/babylon-lite/src/index.ts`.
    - Extend `tests/lite/unit/material-inspection.test.ts`.
- **Work:**
    - Centralize source unwrapping, family dispatch seams, stable family/name fallback, property/binding lookup, tuple copying, numeric/range validation, same-value comparison, scene ownership validation, and U/R/A execution.
    - Implement common `material.name` as A/no-renderer-invalidation and unknown-family identity-only behavior.
    - For R, deduplicate scenes, verify ownership before mutation, and await `{ awaitCompletion: true, rebuildViews: true }`; request frame-graph rebuild only from a family result that reports changed participation.
    - Return applied U/R/A class and post-mutation result; never return `U/R`.
- **Requirements:** REQ-API-1–2, REQ-API-5–8, REQ-DISC-4, REQ-DISC-9–10, REQ-MAT-1–2, REQ-MUT-1–5, REQ-MUT-8–10, REQ-ERR-1–3.
- **Acceptance evidence:** unknown/malformed values do not throw; views resolve to source; invalid/stale IDs and missing scenes reject before writes; identical commits return `changed: false` with no UBO/rebuild activity. Run the focused T04 test and `L-TYPE`.
- **Tree-shaking checkpoint:** family dispatch imports only side-effect-free descriptor modules; no eager map/set/weak-map or registry is introduced.
- **Slice:** `feat(inspector): add material inspection transactions` — **stacked** with family tasks.

### P2 — Lite Family Inspection, Bindings, Metadata, and Mutation

#### T05 — Implement complete Standard material inspection

- **Depends on:** T04.
- **Repository/files:**
    - Add `packages/babylon-lite/src/inspection/standard-material-inspection.ts`.
    - Add `tests/lite/unit/standard-material-inspection.test.ts`.
    - Extend `tests/lite/unit/inspection-mutation.test.ts` when introduced by this slice.
- **Work:**
    - Emit every REQ-STD-1–13 property with approved section, label, state, range/enum, and mutation class; omit Babylon.js-only Standard controls.
    - Emit all nine bindings in canonical order, including distinct 2D and cube reflection entries, absent states, accepted kind/view/sample, transform capability, and exact public setter directions.
    - Route optional slots through existing Standard setters, cube reflection through `setStandardReflectionCubeTexture`, and direct public fields only where architecture allows.
    - Classify alpha feature crossing and other R/U behavior with the same pure feature predicates used by Standard construction; mark U exactly once and rebuild R in all owning scenes/views.
    - Enable stencil/UV transform only through existing public enablers, with Standard transform edits classified R.
- **Requirements:** REQ-MAT-1–4, REQ-STD-1–13, REQ-API-2–3, REQ-MUT-1–5, REQ-MUT-7–9.
- **Acceptance evidence:** matrix-driven tests cover every property/slot, cube type rejection, all supported directions, same-value no-op, U mark count, R scene/view count, and zero mutation for unsupported direction. Run the Standard test plus `inspection-mutation.test.ts`.
- **Tree-shaking checkpoint:** inspection must not import Standard feature fragments or register extensions at module evaluation.
- **Slice:** `feat(inspector): inspect and mutate Standard materials` — **stacked**, parallel-safe with T06/T08/T09 before T10 wiring.

#### T06 — Implement PBR core inspection and feature signatures

- **Depends on:** T04.
- **Repository/files:**
    - Add `packages/babylon-lite/src/inspection/pbr-material-inspection.ts`.
    - Add `tests/lite/unit/pbr-material-inspection.test.ts`.
    - Extend `tests/lite/unit/inspection-mutation.test.ts`.
- **Work:**
    - Cover REQ-PBR-1–10 and REQ-PBR-23–24: general state, alpha/cutoff, base/emissive colors, numeric lighting values, six core texture slots, occlusion, transforms, and stencil.
    - Build before/after signatures from existing pure material-feature predicates; use U only when feature/binding/UV/blend classification is provably unchanged and otherwise R.
    - Route alpha cutoff/emissive through their public setters; preserve `occlusionTexCoord` as read-only.
    - Exclude scattering, local-environment/probe internals, and Babylon.js-only fields.
- **Requirements:** REQ-MAT-1–4, REQ-PBR-1–10, REQ-PBR-23–24, REQ-MUT-1–5, REQ-MUT-8–9.
- **Acceptance evidence:** matrix tests cover all core IDs/slots, range failures, each supported U/R transition, views, no-op commits, read-only UV claim, and omitted internals. Run the PBR and mutation tests.
- **Tree-shaking checkpoint:** core inspection imports no optional PBR fragment, enabler, or setter with registration side effects; mutation-only dynamic imports remain behind the requested operation.
- **Slice:** `feat(inspector): inspect PBR core materials` — **stacked**, parallel-safe with T05/T08/T09.

#### T07 — Add PBR optional-family reconstruction and directional mutation

- **Depends on:** T06.
- **Repository/files:**
    - Modify `packages/babylon-lite/src/inspection/pbr-material-inspection.ts`.
    - Extend `tests/lite/unit/pbr-material-inspection.test.ts`.
    - Extend `tests/lite/unit/inspection-mutation.test.ts`.
- **Work:**
    - Cover REQ-PBR-11–22: lightmap; metallic reflectance; clear coat; sheen; iridescence; anisotropy; translucency/thickness/tint; transmission/dispersion; and special modes.
    - Reconstruct the complete current public option object before changing one member and invoking the existing family setter. Never mutate an internal feature object.
    - Await lightmap enablement before state mutation. Do not report clear for lightmap or metallic-reflectance/reflectance slots.
    - Keep one-way special modes read-only.
    - Treat texture/presence/UV/mode transitions as R, stable in-feature numeric/color edits as U, and unknown transitions as R.
    - Rebuild frame graph only when transmission scene-color participation changes.
- **Requirements:** REQ-PBR-11–22, REQ-MAT-3–4, REQ-MUT-1–5, REQ-MUT-7–10, REQ-TEST-3.
- **Acceptance evidence:** table-driven tests cover every optional field/slot, reconstructed sibling preservation, supported direction sets, no clear/unset calls, read-only one-way modes, enablement rejection, U/R transitions, and transmission frame-graph flags. Run the PBR and mutation tests.
- **Tree-shaking checkpoint:** reading disabled features registers nothing; each setter/enabler is dynamically imported only inside the corresponding mutation branch; filtered bundle output for scenes without that feature remains unchanged.
- **Slice:** `feat(inspector): cover optional PBR material families` — **stacked** on T06.

#### T08 — Implement declaration-driven Shader material inspection

- **Depends on:** T04.
- **Repository/files:**
    - Add `packages/babylon-lite/src/inspection/shader-material-inspection.ts`.
    - Add `tests/lite/unit/shader-material-inspection.test.ts`.
    - Extend `tests/lite/unit/inspection-mutation.test.ts`.
- **Work:**
    - Enumerate non-system scalar/vector/matrix uniforms in declaration order; copy matrix data to a readonly sixteen-number tuple.
    - Omit storage values and system uniforms; expose the approved configuration summary read-only.
    - Enumerate sampler declarations in declaration order with normalized sample/view metadata, including compatible `2d-array`.
    - Validate kinds before `setShaderTexture`; use only `setShaderUniform`/typed wrappers and `setShaderTexture`, with A-owned invalidation and no private counter edits.
- **Requirements:** REQ-SHD-1–5, REQ-API-2–3, REQ-MAT-2–4, REQ-MUT-1, REQ-MUT-4–5, REQ-MUT-7, REQ-TEST-3.
- **Acceptance evidence:** tests cover every supported uniform type, ordering, system/storage omission, configuration read-only state, nullable samplers, incompatible assignment preserving old selection, and no duplicated invalidation. Run the Shader and mutation tests.
- **Tree-shaking checkpoint:** inspection reads declaration data only and adds no compiler/pipeline registration or source-editor dependency.
- **Slice:** `feat(inspector): inspect Shader declarations and samplers` — **stacked**, parallel-safe before T10.

#### T09 — Implement deterministic Node material inspection

- **Depends on:** T04.
- **Repository/files:**
    - Add `packages/babylon-lite/src/inspection/node-material-inspection.ts`.
    - Add `tests/lite/unit/node-material-inspection.test.ts`.
    - Extend `tests/lite/unit/inspection-mutation.test.ts`.
- **Work:**
    - Sort public input keys lexicographically and expose key/type read-only.
    - Map `f32`, `vec2f`, `vec3f`, and `vec4f` values to controlled fields and write only through `NodeInputHandle.value` (A).
    - Map `texture2d` to a nullable canonical binding, write only through `NodeInputHandle.texture`, then perform the declared R post-step in every owning scene/view.
    - Omit graph structure, generated WGSL, unexposed metadata, and editor launch.
- **Requirements:** REQ-NODE-1–4, REQ-MAT-2–4, REQ-MUT-1, REQ-MUT-4–5, REQ-MUT-8–9.
- **Acceptance evidence:** tests cover deterministic key order, all public value handle types, tuple copies, nullable texture directions/navigation, A ownership, and texture rebuild counts. Run the Node and mutation tests.
- **Tree-shaking checkpoint:** no Node editor, graph loader, generated shader, or optional block module is imported by inspection.
- **Slice:** `feat(inspector): inspect Node material inputs` — **stacked**, parallel-safe before T10.

#### T10 — Wire canonical bindings and preserve legacy texture enumeration

- **Depends on:** T05, T07, T08, and T09.
- **Repository/files:**
    - Modify `packages/babylon-lite/src/inspection/material-inspection.ts`.
    - Modify `packages/babylon-lite/src/material/material-textures.ts`.
    - Modify `packages/babylon-lite/src/index.ts`.
    - Modify `tests/lite/unit/material-family.test.ts`.
    - Extend `tests/lite/unit/material-inspection.test.ts`.
- **Work:**
    - Dispatch all supported families and retain identity-only behavior for unknown families.
    - Make `getMaterialTextureBindings()` the only slot enumeration source.
    - Project `getMaterialTextures()` from present canonical bindings, retaining per-slot duplicates and canonical order, omitting absent values and every cube, and accepting views by source unwrapping.
    - Preserve existing type guards and `getMaterialFamily()` behavior.
- **Requirements:** REQ-API-3, REQ-API-6, REQ-API-8, REQ-DISC-1–2, REQ-TEST-1.
- **Acceptance evidence:** exact-order tests cover null slots, duplicate/shared 2D wrappers, cube omission from legacy results, Shader/Node ordering, views, unknown family, and existing guard compatibility. Run `L-UNIT-MATERIAL` and `L-TYPE`.
- **Tree-shaking checkpoint:** remove the old parallel slot-discovery logic; no family registration table or eager collection replaces it.
- **Slice:** `refactor(material): derive texture enumeration from canonical bindings` — **stacked convergence**.

#### T11 — Implement safe texture metadata and consumer-aware transform mutation

- **Depends on:** T03 and T10.
- **Repository/files:**
    - Add `packages/babylon-lite/src/inspection/texture-inspection.ts`.
    - Modify `packages/babylon-lite/src/inspection/material-inspection.ts`.
    - Modify `packages/babylon-lite/src/index.ts`.
    - Add `tests/lite/unit/texture-inspection.test.ts`.
    - Complete `tests/lite/unit/inspection-mutation.test.ts`.
- **Work:**
    - Implement `inspectTexture()` as the sole discriminator and package-private translator for ordinary/cloned 2D, dynamic, HTML, render-target, sampled-depth, array, 3D, cube, unknown, transient, and released cases.
    - Normalize only safe primitives; report unprovable origin/sampler/format metadata as `unknown`, never add always-on provenance solely for Inspector, and expose neither DOM elements nor GPU handles.
    - Report cube dimensions/layers and unsupported transform/orientation mutation.
    - Implement `setTextureInspectionTransform()` by scanning the explicit scene scope through canonical public bindings, matching exact wrapper identity, deduplicating source materials, changing only that wrapper, and applying Standard R plus PBR U/R semantics.
- **Requirements:** REQ-API-4–5, REQ-SCOPE-6, REQ-TEX-1–7, REQ-TK-1–7, REQ-MUT-2–3, REQ-MUT-6–10, REQ-ERR-1, REQ-ERR-3.
- **Acceptance evidence:** kind matrix tests cover dimensions/depth/layers/capabilities/fallbacks, clone identity, cube metadata, no raw handles/DOM, all consumer locations, one invalidation per source, multiple scenes, no-op transforms, and non-consumer rejection. Run `L-UNIT-TEXTURE`, `L-PUBLIC-API`, and `L-TYPE`.
- **Tree-shaking checkpoint:** no constructor hook, global provenance registry, or eager cache; metadata readers disappear when `inspectTexture` is unused.
- **Slice:** `feat(inspector): add safe texture metadata and transforms` — **stacked convergence**.

### P3 — Inspector Lite Resource Index, Discovery, and Refresh

#### T12 — Add an instance-owned Lite scene resource index service

- **Depends on:** T10 and T11.
- **Repository/files (Babylon.js):**
    - Replace the set-based implementation in `packages/dev/inspector-v2/src/lite/services/panes/scene/sceneResources.ts`.
    - Add `packages/dev/inspector-v2/src/lite/services/panes/scene/sceneResourceIndexService.ts`.
    - Modify `packages/dev/inspector-v2/src/lite/inspector.tsx` to register one index service per Inspector/engine.
    - Modify `packages/dev/inspector-v2/test/unit/liteExplorerServices.test.ts`.
- **Work:**
    - Build `LiteSceneResourceIndex` records for source materials, owning scenes, canonical bindings, exact-wrapper texture rows, all consumer edges, safe inspections, and stable monotonic ordinals.
    - Walk meshes in order, ignore null material, collapse views to source, preserve canonical slot order, deduplicate only texture rows, and retain all duplicate consumer edges.
    - Keep maps/weak maps as disposable instance fields; release strong records when unreachable.
- **Requirements:** REQ-DISC-1–5, REQ-DISC-10, REQ-TEX-6–7, REQ-REFRESH-2, REQ-SIZE-2.
- **Acceptance evidence:** tests cover nulls, views, first-reference order, shared/duplicate bindings, clones sharing backing resources, cubes, owning scenes, stable ordinals, and resource release. Run `I-EXPLORER` and `I-COMPILE`.
- **Tree-shaking checkpoint:** no module-level `Map`/`Set`/`WeakMap`; the service is reachable only from the Lite Inspector entry.
- **Slice:** `feat(inspector): index Lite scene materials and textures` — **stacked**.

#### T13 — Move Material and Texture Explorer providers onto the index

- **Depends on:** T12.
- **Repository/files (Babylon.js):**
    - Modify `packages/dev/inspector-v2/src/lite/services/panes/scene/materialExplorerService.tsx`.
    - Modify `packages/dev/inspector-v2/src/lite/services/panes/scene/textureExplorerService.tsx`.
    - Modify `packages/dev/inspector-v2/src/lite/services/panes/scene/sceneExplorerSection.tsx` only if its snapshot typing must accept resource records.
    - Extend `packages/dev/inspector-v2/test/unit/liteExplorerServices.test.ts`.
- **Work:**
    - Use original source/wrapper entities for nodes and existing `GetEntityId`/selection history.
    - Use approved material fallback naming and kind/dimension/ordinal texture naming with `×`.
    - Replace raw object/array snapshots with ordered resource-index topology snapshots.
- **Requirements:** REQ-DISC-1–5, REQ-DISC-8–10, REQ-REFRESH-2, REQ-ERR-1.
- **Acceptance evidence:** Explorer tests prove exact order/names, stable node IDs after rename/reorder/sharing, exact object selection, unknown kinds, zero-size resources, and stale-row removal. Run `I-EXPLORER`.
- **Tree-shaking checkpoint:** Explorer imports only Lite root APIs/resource records, not family component modules or Babylon.js materials/textures.
- **Slice:** `feat(inspector): drive Lite Explorer from resource index` — **stacked**.

#### T14 — Implement topology refresh and index disposal

- **Depends on:** T12 and T13.
- **Repository/files (Babylon.js):**
    - Modify `packages/dev/inspector-v2/src/lite/services/panes/scene/sceneResourceIndexService.ts`.
    - Modify `packages/dev/inspector-v2/src/lite/services/panes/scene/sceneResources.ts`.
    - Modify `packages/dev/inspector-v2/src/lite/inspector.tsx` if disposal ordering needs explicit wiring.
    - Extend `packages/dev/inspector-v2/test/unit/liteExplorerServices.test.ts`.
- **Work:**
    - Produce ordered primitive/reference snapshots compared with `Object.is`, not JSON or GPU identity.
    - Make manual refresh and polling refresh use the same getter.
    - Handle material add/remove/swap, view/source changes, binding changes, sharing changes, dimensions/readiness changes, and selected-resource disappearance according to the existing selection convention.
    - Dispose watchers, index subscriptions, strong records, and service-owned state.
- **Requirements:** REQ-DISC-3, REQ-DISC-10, REQ-REFRESH-1–4, REQ-REFRESH-6, REQ-TEST-4.
- **Acceptance evidence:** fake-timer/manual-refresh tests cover each topology transition, stable retained identity, removed selection behavior, and zero callbacks after Inspector/engine disposal. Run `I-EXPLORER`.
- **Tree-shaking checkpoint:** polling state is allocated only by `ShowInspector`; no Lite runtime hook or entity mutation is added.
- **Slice:** `feat(inspector): refresh and dispose Lite resource topology` — **stacked**.

### P4 — Runtime-Neutral Shared Components

#### T15 — Add shared field models and material section core

- **Depends on:** T01; can proceed in parallel with P1–P3.
- **Repository/files (Babylon.js):**
    - Add `packages/dev/sharedUiComponents/src/fluent/hoc/propertyLines/materialPropertySectionCore.tsx`.
    - Modify `packages/dev/inspector-v2/test/unit/runtimeNeutralPropertyLines.test.tsx`.
- **Work:**
    - Add `PropertyFieldModel` and `MaterialPropertyAdapter` exactly as architecture §7.1.
    - Render text, boolean, finite number, enum, vector2/3, color3/4, matrix4, summary, absent, unsupported, and read-only states using existing Inspector controls.
    - Copy tuple values into controlled drafts and expose Promise commits with initiating-control pending state.
- **Requirements:** REQ-SCOPE-1–3, REQ-ADAPT-1–3, REQ-ADAPT-9, REQ-MAT-1–2, REQ-A11Y-1–2, REQ-A11Y-5.
- **Acceptance evidence:** runtime-neutral tests use fake tuple and Babylon-style mutable adapters, verify labels/ranges/state, reject invalid numeric drafts before commit, and retain focus. Run `I-SHARED` and shared UI compile.
- **Tree-shaking checkpoint:** file has no `core/*` or `@babylonjs/lite` import and no module allocation with side effects.
- **Slice:** `feat(shared-ui): add runtime-neutral material fields` — **independent**.

#### T16 — Add direction-aware texture binding property line

- **Depends on:** T15.
- **Repository/files (Babylon.js):**
    - Add `packages/dev/sharedUiComponents/src/fluent/hoc/propertyLines/textureBindingPropertyLineCore.tsx`.
    - Extend `packages/dev/inspector-v2/test/unit/runtimeNeutralPropertyLines.test.tsx`.
- **Work:**
    - Add `TextureChoiceModel` and `TextureBindingModel`.
    - Render compatible candidates, exact selected identity, assign/replace/clear directions, “None” only when clear is supported, and navigation only when populated.
    - Reject unsupported directions before adapter invocation and restore the previous selection on a rejected commit.
- **Requirements:** REQ-ADAPT-4, REQ-DISC-6–8, REQ-MAT-3, REQ-MUT-5, REQ-MUT-7, REQ-A11Y-1–3, REQ-ERR-3.
- **Acceptance evidence:** pointer/keyboard tests cover empty/present/read-only slots, identity not label matching, destination labels, incompatible candidates, rejected commits, and focus. Run `I-SHARED`.
- **Tree-shaking checkpoint:** no `Scene`, `BaseTexture`, preview/editor/debug component, or runtime-specific type/import.
- **Slice:** `feat(shared-ui): add runtime-neutral texture bindings` — **independent** on T15.

#### T17 — Add metadata-only texture core and accessible operation errors

- **Depends on:** T15 and T16.
- **Repository/files (Babylon.js):**
    - Add `packages/dev/sharedUiComponents/src/fluent/hoc/propertyLines/textureMetadataPropertiesCore.tsx`.
    - Extend `packages/dev/inspector-v2/test/unit/runtimeNeutralPropertyLines.test.tsx`.
- **Work:**
    - Add `TextureMetadataAdapter`; render only adapter-reported identity, size, sampling, orientation, capability, transform, and consumer fields.
    - Omit unsupported controls; keep unknown values explicit and transforms read-only unless capability enables them.
    - Add per-control `aria-busy`, polite validation status, operation alert/retry/dismiss behavior, and focus restoration.
    - Do not define a preview/editor adapter member.
- **Requirements:** REQ-ADAPT-5–9, REQ-TEX-2–5, REQ-A11Y-1–5, REQ-ERR-1–3, REQ-TEST-6–7.
- **Acceptance evidence:** tests cover unknown/absent/zero values, cube/no-transform, zero-size fallback, consumer links, keyboard transform commit, pending/error/retry/dismiss, and absence of every preview/editor action. Run `I-SHARED` and `I-BOUNDARIES`.
- **Tree-shaking checkpoint:** static import test proves the core cannot retain preview/editor/debug modules or either runtime.
- **Slice:** `feat(shared-ui): add metadata-only texture properties` — **independent** on T15/T16.

### P5 — Babylon.js Adapters and Regression Preservation

#### T18 — Adapt Babylon.js material fields and bindings to shared P4 cores

- **Depends on:** T15–T17.
- **Repository/files (Babylon.js):**
    - Add `packages/dev/inspector-v2/src/components/properties/materials/materialPropertyAdapter.tsx`.
    - Add `packages/dev/inspector-v2/src/components/properties/materials/materialTextureBindingAdapter.tsx`.
    - Modify `packages/dev/inspector-v2/src/components/properties/materials/materialProperties.tsx`.
    - Modify `packages/dev/inspector-v2/src/components/properties/materials/standardMaterialProperties.tsx`.
    - Modify `packages/dev/inspector-v2/src/components/properties/materials/pbrBaseMaterialProperties.tsx`.
    - Modify `packages/dev/inspector-v2/src/components/properties/materials/nodeMaterialProperties.tsx`.
    - Modify `packages/dev/inspector-v2/src/services/panes/properties/materialPropertiesService.tsx`.
    - Add `packages/dev/inspector-v2/test/unit/materialTextureAdapterContracts.test.tsx`.
- **Work:**
    - Translate Babylon.js string/number/boolean/vector/color/matrix and texture choices into shared models while preserving native setters, dirtying, property-change notifications, scene selection, and Babylon.js-only rows.
    - Replace only the rows covered by the P4 shared boundary; do not duplicate them. Leave BJS-only sections and `MaterialTextureDebugPropertyLine` behavior outside the Lite/P4 dependency graph.
    - Cover Standard, PBR, Shader, and Node adapter contracts; the adapter may use Babylon.js class checks because it belongs to the Babylon.js entry.
- **Requirements:** REQ-SCOPE-1–3, REQ-ADAPT-2–4, REQ-ADAPT-10, REQ-TEST-2, REQ-TEST-5.
- **Acceptance evidence:** shared contract tests run against Babylon.js entities and preserve existing value changes, dirty flags, notifications, candidate selection, and navigation; existing focused material tests stay green. Run `I-SHARED`, `I-PROPERTIES`, `I-COMPILE`, and `I-LINT`.
- **Tree-shaking checkpoint:** adapter is reachable only from the Babylon.js entry and contains no `@babylonjs/lite`; no new edge is added from the shared core back to `core/*`.
- **Slice:** `refactor(inspector): adapt Babylon materials to shared property cores` — **independent of Lite adapter landing**.

#### T19 — Adapt Babylon.js metadata rows without touching preview/editor

- **Depends on:** T17; may run parallel with T18.
- **Repository/files (Babylon.js):**
    - Add `packages/dev/inspector-v2/src/components/properties/textures/textureMetadataAdapter.tsx`.
    - Modify metadata-row composition only in `packages/dev/inspector-v2/src/components/properties/textures/baseTextureProperties.tsx`.
    - Modify metadata-row composition only in `packages/dev/inspector-v2/src/components/properties/textures/textureProperties.tsx`.
    - Modify metadata-row composition only in `packages/dev/inspector-v2/src/components/properties/textures/cubeTextureProperties.tsx`.
    - Modify `packages/dev/inspector-v2/src/services/panes/properties/texturePropertiesService.tsx`.
    - Extend `packages/dev/inspector-v2/test/unit/materialTextureAdapterContracts.test.tsx`.
- **Work:**
    - Translate safe Babylon.js metadata/transforms/consumers to `TextureMetadataAdapter` and preserve its native mutation semantics.
    - Keep `BaseTexturePreviewProperties`, `TexturePreview`, `TextureUpload`, `TextureEditor`, texture-editor service, channel/face/layer/slice/LOD behavior, and texture-debug materials byte-for-byte outside this refactor.
- **Requirements:** REQ-ADAPT-2, REQ-ADAPT-5–8, REQ-ADAPT-10, REQ-TEST-5–6.
- **Acceptance evidence:** BJS adapter tests cover 2D/array/3D/cube metadata and transforms; existing preview/editor service registration and actions remain unchanged; static boundary tests pass. Run `I-SHARED`, `I-BOUNDARIES`, `I-COMPILE`, and `I-LINT`.
- **Tree-shaking checkpoint:** no Lite import; shared metadata core has no reverse edge to BJS preview/editor.
- **Slice:** `refactor(inspector): adapt Babylon texture metadata rows` — **independent of Lite adapter landing**.

### P6 — Lite Material/Texture Adapters and Lifecycle

#### T20 — Add lazy Lite material family adapters and Properties integration

- **Depends on:** T10–T12 and T15–T18.
- **Repository/files (Babylon.js):**
    - Add:
        - `packages/dev/inspector-v2/src/lite/services/panes/properties/materialAdapters/materialAdapterCore.ts`
        - `packages/dev/inspector-v2/src/lite/services/panes/properties/materialAdapters/standardMaterialAdapter.tsx`
        - `packages/dev/inspector-v2/src/lite/services/panes/properties/materialAdapters/pbrMaterialAdapter.tsx`
        - `packages/dev/inspector-v2/src/lite/services/panes/properties/materialAdapters/shaderMaterialAdapter.tsx`
        - `packages/dev/inspector-v2/src/lite/services/panes/properties/materialAdapters/nodeMaterialAdapter.tsx`
    - Replace direct rows in `packages/dev/inspector-v2/src/lite/services/panes/properties/materialPropertiesService.tsx`.
    - Extend `packages/dev/inspector-v2/test/unit/litePropertiesServices.test.tsx`.
- **Work:**
    - Use `inspectMaterial()` as the predicate/discriminator; render unknown families with common identity only.
    - Convert snapshots and resource-index candidate lists into shared fields/bindings; pass complete owning-scene scope into mutation calls.
    - Select the family component with a dynamic import only after family resolution. A family adapter imports no other family implementation and no Babylon.js material/texture class.
    - Use exact original texture entities for selection/navigation and expose only public binding directions.
- **Requirements:** REQ-SCOPE-1–6, REQ-ADAPT-1–5, REQ-ADAPT-9–10, REQ-DISC-6–10, REQ-MAT-1–4, REQ-STD-1–13, REQ-PBR-1–24, REQ-SHD-1–5, REQ-NODE-1–4.
- **Acceptance evidence:** matrix component tests assert D/E/N and omission for every required row, exact candidate filtering, empty state, cube navigation, unsupported clears absent, one-way modes read-only, exact entity history, and no cross-runtime import. Run `I-PROPERTIES`, `I-BOUNDARIES`, and `I-COMPILE`.
- **Tree-shaking checkpoint:** entry chunk contains only family detection/loading seam; Standard/PBR/Shader/Node chunks load on selection and contain no preview/editor dependency.
- **Slice:** `feat(inspector): add Lite material family adapters` — **stacked integration**.

#### T21 — Add Lite metadata-only texture adapter and Properties integration

- **Depends on:** T11–T14 and T17–T19.
- **Repository/files (Babylon.js):**
    - Add `packages/dev/inspector-v2/src/lite/services/panes/properties/liteTextureMetadataAdapter.ts`.
    - Replace duck typing in `packages/dev/inspector-v2/src/lite/services/panes/properties/texturePropertiesService.tsx`.
    - Extend `packages/dev/inspector-v2/test/unit/litePropertiesServices.test.tsx`.
- **Work:**
    - Use `inspectTexture()` as the sole predicate/discriminator.
    - Dynamically load the metadata-only component for a selected indexed texture.
    - Map all safe metadata fields and current-scene consumer links; enable transform only when the index proves at least one Standard/PBR standard-transform consumer.
    - Commit through `setTextureInspectionTransform()` with explicit owning scenes; select original material/texture objects for links.
    - Render cube metadata only and expose no Lite preview/editor action or placeholder.
- **Requirements:** REQ-API-4, REQ-ADAPT-5–8, REQ-DISC-5–8, REQ-TEX-1–7, REQ-TK-1–7, REQ-MUT-6, REQ-ERR-1.
- **Acceptance evidence:** tests cover every texture kind, exact cube/clone identity, unknown facts, all consumers, transform capability gating, Standard/PBR invalidation call, empty navigation behavior, and complete absence of preview/editor actions. Run `I-PROPERTIES`, `I-BOUNDARIES`, and `I-COMPILE`.
- **Tree-shaking checkpoint:** metadata component loads only for selected texture; no BJS class or preview/editor import; Lite runtime applications that do not load Inspector are unaffected.
- **Slice:** `feat(inspector): add Lite metadata-only texture properties` — **stacked integration**.

#### T22 — Add adapter operation generations, refresh, errors, and cleanup

- **Depends on:** T14, T20, and T21.
- **Repository/files (Babylon.js):**
    - Add `packages/dev/inspector-v2/src/lite/services/panes/properties/materialAdapters/adapterOperationController.ts`.
    - Modify `packages/dev/inspector-v2/src/lite/services/panes/properties/materialAdapters/materialAdapterCore.ts`.
    - Modify each family adapter from T20.
    - Modify `packages/dev/inspector-v2/src/lite/services/panes/properties/liteTextureMetadataAdapter.ts`.
    - Modify both Lite Properties services.
    - Extend `packages/dev/inspector-v2/test/unit/litePropertiesServices.test.tsx`.
- **Work:**
    - Give each adapter `{ generation, AbortController, disposed }`; cancel prior UI work and gate completion/error state by entity, row ID, and generation.
    - Reinspect after success/failure, request one watcher refresh after successful changed mutations, and preserve last valid runtime value on validation/setter/enable/rebuild failure.
    - Re-evaluate capability-dependent rows after binding/feature/kind changes.
    - Use accessible status/alert state; do not console-log routine unsupported/validation cases, and log unexpected failures at most once per operation.
    - Dispose controllers, watchers, subscriptions, and adapter-owned resources on section/Inspector/engine disposal.
- **Requirements:** REQ-ADAPT-9, REQ-MUT-9–10, REQ-REFRESH-1, REQ-REFRESH-3–6, REQ-A11Y-4, REQ-ERR-1–3, REQ-TEST-4, REQ-TEST-7.
- **Acceptance evidence:** fake-timer/deferred-Promise tests cover manual and polling updates, next-refresh visibility, same-value no churn, feature row appearance, selection change, late resolve/reject, unmount, engine disposal, retry, error announcement, focus retention, and zero post-dispose updates. Run `I-PROPERTIES` and `I-EXPLORER`.
- **Tree-shaking checkpoint:** controller state is per mounted adapter; no global cache/subscription and no permanent hook on Lite entities.
- **Slice:** `feat(inspector): harden Lite adapter refresh lifecycle` — **stacked integration**.

### P7 — Cross-Layer Verification, Isolation, and Size

#### T23 — Close the focused behavior, accessibility, and refresh matrix

- **Depends on:** T05–T22.
- **Repository/files:**
    - Complete all Lite unit files named in T05–T11.
    - Complete Babylon.js:
        - `packages/dev/inspector-v2/test/unit/runtimeNeutralPropertyLines.test.tsx`
        - `packages/dev/inspector-v2/test/unit/materialTextureAdapterContracts.test.tsx`
        - `packages/dev/inspector-v2/test/unit/liteExplorerServices.test.ts`
        - `packages/dev/inspector-v2/test/unit/litePropertiesServices.test.tsx`
- **Work:**
    - Convert the requirements matrices into data-driven coverage so each property/binding ID asserts section, label, value state, access, directions, candidate kinds, and applied U/R/A path.
    - Add explicit negative assertions for every omission, unsupported clear/unset, one-way mode edit, raw/private value, preview/editor action, invalid number/kind, and routine console error.
    - Cover external changes in manual/polling modes, all consumer links, selection history, source/view sharing, async disposal, and accessibility.
- **Requirements:** REQ-TEST-1–7 plus every product requirement as detailed in §6.
- **Acceptance evidence:** `L-UNIT-MATERIAL`, `L-UNIT-TEXTURE`, `L-UNIT-REBUILD`, `I-SHARED`, `I-EXPLORER`, and `I-PROPERTIES` all pass with no skipped matrix row.
- **Tree-shaking checkpoint:** tests assert lazy family/texture loads and absence of preview/editor/cross-runtime edges, not just UI behavior.
- **Slice:** `test(inspector): complete P4 behavior and lifecycle matrix` — **stacked convergence**.

#### T24 — Verify public surface, builds, package isolation, and runtime bytes

- **Depends on:** T23.
- **Repository/files:**
    - Finalize `tests/lite/build/public-api-types.test.ts`.
    - Finalize `tests/lite/build/inspection-treeshake.test.ts`.
    - Finalize `packages/dev/inspector-v2/test/unit/p4ImportBoundaries.test.ts`.
    - Do not modify `scene-config.json`, golden files, `lab/public/bundle/**`, or a bundle-size threshold.
- **Work:**
    - Verify root-only exports, public declaration trimming, no raw GPU reachability, no module side effects, and legacy public API compatibility.
    - Compare unused-inspection Rollup output byte-for-byte with the baseline entry.
    - Build only `scene1`, `scene26`, and `scene28`; verify no inspection-caused runtime-loaded byte/chunk delta and all existing ceilings remain satisfied.
    - Verify Inspector family/metadata chunks are lazy and contain neither preview/editor nor the opposite runtime.
    - Run final typechecks/compiles and mandatory repository style checks.
- **Requirements:** REQ-SIZE-1–5, REQ-TEST-6, REQ-TEST-8–9, REQ-SCOPE-5–6, REQ-ADAPT-10.
- **Acceptance evidence:** `L-PUBLIC-API`, `L-TREESHAKE`, `L-TYPE`, `L-FILTERED-SIZE`, `L-FINAL-STYLE`, `I-BOUNDARIES`, `I-COMPILE`, and `I-LINT` pass. Generated bundle output remains untracked. No local visual/parity/performance/all-scene command runs.
- **Tree-shaking checkpoint:** this is the release gate: zero non-Inspector runtime bytes and fetched chunks, no ceiling changes, and no cross-runtime or preview/editor retention.
- **Slice:** `test(inspector): verify P4 API and package isolation` — **final convergence**.

## 6. Requirement Traceability

Every approved requirement is assigned to implementation tasks and focused evidence:

| Requirement group | Implemented by             | Principal acceptance evidence                                                                   |
| ----------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| REQ-SCOPE-1–6     | T02, T04, T15–T24          | Root/public type tests, shared-core contracts, Lite/BJS service tests, import boundaries        |
| REQ-API-1–8       | T02, T04–T11               | Public declaration probes, family/binding/texture snapshots, view and deterministic-order tests |
| REQ-ADAPT-1–10    | T15–T22, T24               | Shared fake/BJS/Lite adapters, no preview/editor boundary, cross-runtime import tests           |
| REQ-DISC-1–10     | T10, T12–T14, T20–T22      | Resource-index ordering/identity/ordinal/consumer tests and exact selection/history tests       |
| REQ-MAT-1–4       | T04–T11, T15–T20           | Matrix omissions, finite/range validation, compatible directional selector, public-setter spies |
| REQ-STD-1–13      | T05, T20, T23              | Complete Standard descriptor/UI matrix and U/R/cube/stencil/transform mutation tests            |
| REQ-PBR-1–10      | T06, T20, T23              | PBR core descriptor/UI matrix and feature-signature mutation tests                              |
| REQ-PBR-11–22     | T07, T20, T23              | Optional feature reconstruction, directional binding, read-only mode, transmission tests        |
| REQ-PBR-23–24     | T06, T11, T20, T23         | Consumer-aware UV enablement and stencil rebuild tests                                          |
| REQ-SHD-1–5       | T08, T20, T23              | Declaration-order typed uniform/sampler and read-only/omission tests                            |
| REQ-NODE-1–4      | T09, T20, T23              | Lexicographic handle value/texture and rebuild tests                                            |
| REQ-TEX-1–7       | T11–T14, T17, T21–T23      | Discriminator, identity, consumer, metadata, transform, and Explorer tests                      |
| REQ-TK-1–7        | T11, T17, T21, T23         | Full kind matrix including dynamic, HTML, RT/depth, arrays, 3D, clone, and cube                 |
| REQ-MUT-1–10      | T03–T11, T20–T23           | Public setter/handle spies, exact U/R/A counts, scenes/views/frame graph, failure/no-op tests   |
| REQ-REFRESH-1–6   | T12–T14, T20–T23           | Manual/polling topology/property refresh, generation, stale selection, and disposal tests       |
| REQ-A11Y-1–5      | T15–T17, T20–T23           | Accessible query, keyboard, focus, state, busy/status/alert, link-name tests                    |
| REQ-ERR-1–3       | T04, T11, T15–T17, T20–T23 | Safe fallbacks and prevalidation, accessible errors, no routine console noise                   |
| REQ-SIZE-1–5      | T01–T02, T05–T24           | Side-effect/import guards, lazy chunks, byte-identical unused build, filtered size checks       |
| REQ-TEST-1–9      | T01, T23–T24               | Complete focused suite; explicit no visual/all-scene/golden/ceiling work                        |

**Traceability status:** complete; every normative `REQ-*` identifier in `requirements.md` is covered by at least one implementation task and one acceptance-evidence path.

## 7. Commit/PR Slice Summary

Recommended stacked slices preserve reviewability and allow safe independent work:

1. **Lite L1:** T01–T04 — contract types, transaction foundation, awaited rebuild.
2. **Lite L2:** T05 — Standard snapshots, bindings, and mutation routing.
3. **Lite L3:** T06–T07 — PBR core/optional coverage.
4. **Lite L4:** T08–T09 — Shader and Node coverage.
5. **Lite L5:** T10–T11 — canonical convergence, legacy projection, texture metadata/transforms.
6. **Inspector S1:** T15–T17 — runtime-neutral shared cores; independently reviewable.
7. **Inspector B1:** T18–T19 — Babylon.js adapters; independently reviewable from Lite integration.
8. **Inspector L1:** T12–T14 — Lite resource index/Explorer/refresh after the Lite API is consumable.
9. **Inspector L2:** T20–T22 — Lite Properties adapters, navigation, async lifecycle.
10. **Verification V1:** T23–T24 — focused matrix, imports, builds, and size gate.

Do not squash away a failing test-first boundary while work is in progress. Final PRs should use normal Conventional Commit titles; this feature is additive and carries no breaking-change marker.

## 8. Approval Gate and Open Planning Decisions

There are **no open planning decisions**. Private helper/file granularity may change during implementation only when all public signatures, capability directions, U/R/A outcomes, module-loading boundaries, and task evidence remain equivalent.

Implementation approval authorizes T01–T24 in dependency order. It does not authorize preview/editor work, new clear/unset or reversible mode APIs, visual/golden updates, bundle-ceiling changes, source changes during this planning phase, or a `task-board.md` edit.
