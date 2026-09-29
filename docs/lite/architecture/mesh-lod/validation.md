# MeshLoD Validation & Requirement Traceability

> Task 9.1 (`implementation-plan/09_01_full_validation_traceability.md`).
> This document records the concrete, reproducible evidence that every MeshLoD
> requirement (`requirements.md`) is implemented and covered by a passing test or
> inspection. It changes no thresholds, goldens, or validation — it only records
> the state of the completed implementation (tasks T-06 … T-42).
>
> **Historical snapshot (July 2026):** The converter has since moved to
> [MegameshCLI](https://github.com/CedricGuillemet/MegameshCLI). Results and
> checksums below describe the original in-tree converter; they are not evidence
> for a new release or a current CI run. Follow the CLI repository's workflows
> for current native builds, conversions, and asset credits.

Performance, visual/parity, and all-scene suites are **user/CI-only** by
`GUIDANCE.md` §0c. Run only focused nonvisual tests, filtered bundles, and
lint locally. The old full-suite results below remain an archived record.

## 1. How to reproduce

Toolchain used for the historical run: Node 22.22.3, pnpm 9.4.0, CMake 4.3.1, Ninja,
MSVC 14.51 (VS 2026), Chrome (real WebGPU).

### Converter (native)

```powershell
# From a MegameshCLI checkout (Developer prompt / vcvars64 for MSVC + Ninja).
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build
ctest --test-dir build --output-on-failure

# provenance
build/mesh-lod-tool.exe --version

# Compare two independently generated outputs using the same CLI build/options.
# The older checked-in Lite .mlod files are compatibility fixtures, not
# byte-identical output expectations after the deterministic fingerprint changed.
build/mesh-lod-tool.exe --input assets/harvard-yenching_institute_statue.glb `
  --output <tmp-a>/harvard-yenching_institute_statue.mlod --stats-json <tmp-a>/statue-stats.json
build/mesh-lod-tool.exe --input assets/harvard-yenching_institute_statue.glb `
  --output <tmp-b>/harvard-yenching_institute_statue.mlod --stats-json <tmp-b>/statue-stats.json

# validate-only (no output written)
build/mesh-lod-tool.exe --input assets/harvard-yenching_institute_statue.glb `
  --output <tmp>/x.mlod --validate-only
```

### Engine / runtime (Vitest)

```powershell
pnpm exec vitest run --project unit --project lite-integration --project no-webgpu mesh-lod
pnpm exec vitest run --project build mesh-lod-tree-shaking
```

### Demo workflow (Playwright, real WebGPU)

```powershell
pnpm build:bundle-demo mesh-lod
$env:LAB_TEST_PORT="5174"; $env:HEADLESS="true"   # reuses the running lab dev server
npx playwright test tests/lite/demo/mesh-lod-demo.spec.ts
```

### Lint + focused bundle checks

```powershell
pnpm run lint:fix
pnpm run lint
pnpm build:lib
pnpm exec tsx scripts/build-bundle-scenes.ts --scenes scene1,scene164
```

## 2. Results summary (historical in-tree run)

| Area | Command | Result |
| --- | --- | --- |
| Converter clean build + CTest | `cmake … && ctest` | **7/7 passed** (`tool_smoke`, `cli_help`, `cli_version`, `cli_version_meshoptimizer_pin`, `cli_version_cgltf_pin`, `cli_unknown_arg`, `format_vectors`) |
| Converter provenance | `--version` | `tool_version=0.1.0` · `format_version=1.0` · `meshoptimizer_revision=f843aae0…` · `cgltf_revision=85cd6238…` |
| Deterministic conversion | reconvert + SHA-256 compare | **byte-identical** for the former in-tree writer; compare two fresh conversions for new CLI builds |
| Validate-only | `--validate-only` | **exit 0**, no output written |
| Unit + integration + no-WebGPU | `vitest run --project unit --project lite-integration --project no-webgpu mesh-lod` | **281 passed** (31 files) |
| Tree-shaking | `vitest run --project build mesh-lod-tree-shaking` | **3 passed** |
| Demo workflow | `playwright test tests/lite/demo/mesh-lod-demo.spec.ts` | **8/8 passed** (real WebGPU, `http://localhost:5174`) |
| Lint (eslint + 6× tsc) | `pnpm run lint` | **green** (lint:fix produced no changes) |
| Non-MeshLoD bundle isolation | manifest + bundle-info scan | **0/216** scene manifests fetch a MeshLoD chunk; only `demo-mesh-lod` bundle-info references MeshLoD |
| Public API surface | trimmed `build/index.d.ts` inspection | 12 functions + 13 types match `architecture.md` §5; **0 GPU handles** in any MeshLoD public interface; `@internal` fields (`_runtime`, `_asset`, `_material`, `_instanceId`) stripped |
| Mandatory guardrails | `pnpm test` (worktree, `LAB_TEST_PORT=5207`) | see §5 |

The statue converts to three primitives (source triangles 98366 + 119201 + 93519
= **311086**), 12 hierarchy levels each, 40/46/38 pages (1 pinned each). These match
the committed `lab/public/mesh-lod/statue-stats.json`.

## 3. Test inventory (what each suite proves)

### Native converter — `MegameshCLI/tests`

- `tool_tests.cpp` (CTest `tool_smoke`): version/help, option defaults, valid values,
  range boundaries, error/exit codes, deterministic primitive naming, canonical
  option form (no input-path leakage), fixture ingestion + rejection, hierarchy
  build, and end-to-end convert / repeat-convert / validate-only / multi-primitive /
  unsupported-mix. Rejection fixtures: `points` (non-`TRIANGLES`), `skinned`, `morph`,
  `alpha_blend`, `transmission`, `draco` (compression), `sparse` (accessor layout),
  `textured_no_uv` (`TEXCOORD_0`), `bad_index`, `malformed`, `does_not_exist` (I/O).
- `format_tests.cpp` (CTest `format_vectors`): binary layout offsets, little-endian
  helpers, checked arithmetic, CRC32C check + streaming vectors, SHA-256 published
  vectors, and source-digest fingerprint.

### Engine unit + integration + no-WebGPU + build — `tests/lite/**/mesh-lod*`

Unit (`tests/lite/unit/mesh-lod/`): `mesh-lod-api`, `-options`, `-format`,
`-range-source`, `-page-decoder`, `-selection-cpu`, `-scene`, `-scheduler`, `-cache`,
`-gpu-layout`, `-gpu-readback`, `-frame-refs`, `-disposal`, `-debug-view`,
`-camera-path`, `-network-simulator`.
Integration (`tests/lite/integration/mesh-lod/`): `-http`, `-loader`, `-coarse-path`,
`-coarse-render`, `-indirect-render`, `-render-equivalence`, `-selection-gpu`,
`-selection-equivalence`, `-streaming`, `-streaming-cache`, `-gpu-streaming`,
`-lifecycle`, `-shared-lifecycle`, `-device-recovery`.
No-WebGPU (`tests/lite/no-webgpu/`): `mesh-lod-import` (import with no WebGPU globals).
Build (`tests/lite/build/`): `mesh-lod-tree-shaking` (zero MeshLoD code for unrelated
imports; runtime/renderable/decoder behind dynamic chunks; positive control).

### Demo — `tests/lite/demo/mesh-lod-demo.spec.ts`

Drives the production-bundled demo (`/lite/bundle/demos/mesh-lod.js`) in real WebGPU.
Full per-`REQ-DEMO-*` mapping is in `demo-verification.md`.

## 4. Requirement → evidence

Legend: **T** = native converter test, **U/I/N/B** = Vitest unit/integration/no-webgpu/build,
**D** = demo Playwright, **P** = `pnpm test` parity+bundle guardrail, **X** = inspection.

| Requirement | Evidence | Type |
| --- | --- | --- |
| `REQ-NAME-1` | Feature/tool/format/demo strings use `MeshLoD`; deps (`meshoptimizer`, `cgltf`) appear only as dependencies. API/tool/demo string review; `--version`. | X |
| `REQ-NAME-2` | Clean `cmake -S mesh-lod-tool -B mesh-lod-tool/build` from the tool root. | T |
| `REQ-NAME-3` | `harvard-yenching_institute_statue.glb` → `.mlod`; demo loads it via `loadMeshLoD`. | T,D |
| `REQ-NAME-4` | Converter + `.mlod` contract + engine feature + demo are distinct deliverables; demo uses engine APIs (`mesh-lod-demo.spec.ts`). | X,D |
| `REQ-TOOL-1` | CMake configure + Release build (Ninja); README documents single- and multi-config. | T |
| `REQ-TOOL-2` | `FetchContent` pins exact SHAs; `cli_version_meshoptimizer_pin`/`cli_version_cgltf_pin`. | T |
| `REQ-TOOL-3` | `tool_tests.cpp::testIngestion` loads `.gltf`/`.glb`; `malformed`/`bad_index` rejected. | T |
| `REQ-TOOL-4` | Statue non-zero groups/clusters/triangles; validator over hierarchy/meshlets (`testHierarchy`, `testEndToEnd`). | T |
| `REQ-TOOL-5` | `--help` lists every option (`cli_help`); missing/invalid/conflicting args → `kExitCli` (`testErrors`). | T |
| `REQ-TOOL-6` | `--version` prints tool/format/dep provenance without an input asset; matches metadata. | T |
| `REQ-TOOL-7` | Reconvert byte-identical (SHA-256) for 3 `.mlod` + stats; `testCanonicalOptions` (no path/timestamp). | T |
| `REQ-TOOL-8` | Validation runs pre-success; `--validate-only` exit 0; canonical `statue-stats.json`; `format_tests` integrity. | T |
| `REQ-TOOL-9` | One rejection fixture per failure class with mesh/primitive/accessor context (`testIngestion`); `does_not_exist`→`kExitIo`. | T |
| `REQ-GEO-1` | `points`/`skinned`/`morph`/`alpha_blend`/`transmission` rejected; triangle fixtures succeed. | T |
| `REQ-GEO-2` | `triangle_indexed`(.gltf/.glb) + `triangle_unindexed` normalize to equivalent geometry. | T |
| `REQ-GEO-3` | Missing normals generated finite; `textured_no_uv`→`TEXCOORD_0` error; untextured-without-UV succeeds. | T |
| `REQ-GEO-4` | `draco` (compression) + `sparse` (accessor layout) rejected with a precise message. | T |
| `REQ-GEO-5` | Hierarchy built in primitive-local space; two transformed instances share one asset (`mesh-lod-selection-equivalence`). | I |
| `REQ-GEO-6` | `two_primitives`/`mixed` → separate named containers, no cross-material refs; `mixed`→`kExitUnsupported`. | T |
| `REQ-GEO-7` | Exhaustive DAG-cut coverage; incomplete-group residency never mixes parent/child (`mesh-lod-selection-cpu`, `-streaming`). | U,I |
| `REQ-FMT-1` | One container per primitive; unsupported major rejected; no per-meshlet files (`mesh-lod-format`, `testNaming`). | U,T |
| `REQ-FMT-2` | Identity + range server load (`mesh-lod-http`); README documents transform incompatibility. | I |
| `REQ-FMT-3` | Coarse render from bootstrap ranges with fine disabled (`mesh-lod-loader`, `-coarse-path`). | I |
| `REQ-FMT-4` | Page size 64–256 KiB validated; multi-meshlet pages (`mesh-lod-format`; statue stats). | U,T |
| `REQ-FMT-5` | Metadata/provenance fields parsed + compared to `--version` (`mesh-lod-format`, `-loader`). | U,I |
| `REQ-FMT-6` | CRC/truncation/overlap/count/reference/version mutation corpus (`mesh-lod-format` mutation matrix; `format_tests`). | U,T |
| `REQ-FMT-7` | Full-body HTTP 200 retained + served; invalid 200/206 rejected (`mesh-lod-http`, `-streaming-cache`). | I |
| `REQ-LOAD-1` | Load resolves after coarse upload, before fine completion (`mesh-lod-loader`, `-coarse-path`). | I |
| `REQ-LOAD-2` | Invalid/effective budget + concurrency; diagnostics snapshot (`mesh-lod-options`, `-api`). | U |
| `REQ-LOAD-3` | Abort race, repeated dispose, scene pruning, accounting (`mesh-lod-disposal`, `-shared-lifecycle`). | U,I |
| `REQ-LOAD-4` | Forced device-loss recovery from retained pages; terminal coarse failure (`mesh-lod-device-recovery`). | I |
| `REQ-SEL-1` | CPU oracle fixtures with committed ordered IDs (`mesh-lod-selection-cpu`). | U |
| `REQ-SEL-2` | GPU IDs normalized == CPU oracle across fixtures (`mesh-lod-selection-gpu`, `-render-equivalence`, `-selection-equivalence`). | I |
| `REQ-SEL-3` | Threshold refine/stop + unmet-error fallback (`mesh-lod-selection-cpu`, `-streaming`). | U,I |
| `REQ-SEL-4` | Outside → none; intersecting → visible (`mesh-lod-selection-cpu`, `-selection-equivalence`). | U,I |
| `REQ-SEL-5` | Refine/coarsen boundary + camera-jitter stability (`mesh-lod-selection-equivalence`). | I |
| `REQ-SEL-6` | Group refines only when its replacement pages are resident (`mesh-lod-streaming`). | I |
| `REQ-SEL-7` | Delay/cancel/fail/retry/evict keep terminal group (`mesh-lod-coarse-path`, `-streaming`, `-streaming-cache`). | I |
| `REQ-STREAM-1` | Page-specific range requests match metadata (`mesh-lod-http`, `-streaming`). | I |
| `REQ-STREAM-2` | Instrumented max in-flight under stress + bound change (`mesh-lod-streaming-cache`, `-scheduler`). | U,I |
| `REQ-STREAM-3` | Repeated demand → one fetch + shared result (`mesh-lod-scheduler`, `-streaming-cache`). | U,I |
| `REQ-STREAM-4` | Queued removal, in-flight abort, stale-generation discard (`mesh-lod-scheduler`, `-streaming`). | U,I |
| `REQ-STREAM-5` | Benefit/cost ordering + visible-demand starvation (`mesh-lod-scheduler`, `-gpu-readback`). | U |
| `REQ-STREAM-6` | Retryable/permanent status matrix, bounded delay/count (`mesh-lod-scheduler`, `-streaming-cache`). | U,I |
| `REQ-CACHE-1` | Block accounting; no committed allocation over effective budget (`mesh-lod-cache`, `-streaming-cache`). | U,I |
| `REQ-CACHE-2` | Pinned-size boundary success/failure + non-eviction (`mesh-lod-cache`, `-streaming-cache`). | U,I |
| `REQ-CACHE-3` | Current-frame/upload/pinned/in-flight victims excluded (`mesh-lod-cache`, `-lifecycle`). | U,I |
| `REQ-CACHE-4` | 120-frame hold + two-frame obsolete grace jitter (`mesh-lod-cache`, `-scheduler`). | U |
| `REQ-RENDER-1` | WebGPU raster pipeline (`pbr-mesh-lod-renderable`); `mesh-lod-indirect-render`. | I |
| `REQ-RENDER-2` | One indirect draw per material/hierarchy batch while meshlet count varies (`mesh-lod-indirect-render`, `-render-equivalence`). | I |
| `REQ-RENDER-3` | Pipeline/WGSL/BGL live under `material/pbr/pbr-mesh-lod-*`; renderer sees an ordinary Renderable. | X,I |
| `REQ-RENDER-4` | Make-before-break growth/eviction/dispose/recovery submission safety (`mesh-lod-lifecycle`, `-frame-refs`, `-device-recovery`). | U,I |
| `REQ-INT-1` | 0/216 scene manifests fetch a MeshLoD chunk; bundle-size ceilings pass (`mesh-lod-tree-shaking`; `pnpm test`). | B,P,X |
| `REQ-INT-2` | Runtime/material/decoder chunks load only after `loadMeshLoD` (`mesh-lod-tree-shaking`). | B |
| `REQ-INT-3` | Public interfaces are state-only; behavior via standalone functions (`build/index.d.ts` §5). | X |
| `REQ-INT-4` | No scene reference in asset/instance; remove/dispose isolates instances (`mesh-lod-scene`, `-shared-lifecycle`). | U,I |
| `REQ-INT-5` | Trimmed public `.d.ts`: 0 GPU handles in any MeshLoD interface; `_runtime`/`_asset`/`_material`/`_instanceId` stripped. | X |
| `REQ-INT-6` | Import-without-call is inert (`mesh-lod-import` no-WebGPU); no eager module-level collections/registration. | N,X |
| `REQ-INT-7` | Two transformed instances share one payload; disposing one keeps the other live (`mesh-lod-shared-lifecycle`, `-selection-equivalence`). | I |
| `REQ-INT-8` | Full agent-allowed build/parity/bundle green, ceilings + goldens unchanged (`pnpm test`). | P |
| `REQ-DEMO-1..7` | `mesh-lod-demo.spec.ts` 8/8 real WebGPU; per-requirement rows in `demo-verification.md`. | D |
| `REQ-VERIFY-1` | Converter test inventory (§3) maps every tool/geometry behavior + failure class. | T |
| `REQ-VERIFY-2` | Binary/range mutation corpus (`mesh-lod-format`, `-http`, `-streaming-cache`, `format_tests`). | U,I,T |
| `REQ-VERIFY-3` | CPU/GPU fixture matrix: thresholds, frusta, residency, hysteresis, transforms (`mesh-lod-selection-*`, `-render-equivalence`). | I |
| `REQ-VERIFY-4` | Deterministic fake-fetch/clock harness over every scheduler/cache invariant (`mesh-lod-streaming-cache`, `-scheduler`, `-cache`). | U,I |
| `REQ-VERIFY-5` | Parity + bundle suites pass with no MeshLoD chunk in any scene fetch log (`pnpm test`; manifest scan). | P,X |
| `REQ-VERIFY-6` | Demo verification suite passes for every control/diagnostic/debug view/fallback/ready-error state (`mesh-lod-demo.spec.ts`; `demo-verification.md`). | D |

## 5. Mandatory guardrail run (`pnpm test`)

Executed in a **clean linked git worktree** checked out at the validated commit and
installed with an isolated virtual store (`--virtual-store-dir .p`), on a unique
`LAB_TEST_PORT=5207`, so the working tree's pre-existing dirty manifests and lockfile
are untouched and the bundle baseline is not polluted.

- `build:bundle-scenes`: **built all 216 scenes**; regenerated per-scene manifests match
  the committed baseline except the pre-existing scene113/114/115 drift (unrelated to
  MeshLoD — no MeshLoD chunk enters any scene).
- **Bundle-size ceilings: 213 passed / 0 failed** — every scene stays within its
  committed ceiling; no ceiling was raised.
- **Parity: 432 passed / 4 failed (13.9 min).** The 4 failures are the known
  baseline-only set that is **not** a MeshLoD regression and fails identically on the
  pre-MeshLoD baseline (documented across milestones T-22/T-26/T-30/T-33/T-36/T-42):
  `scene104` (character controller), `scene105` (moving platform), `scene106` (prestep
  motion types) — physics character-controller nondeterminism — and `scene265`
  (EnvironmentTest) — GPU precision. Each failed all three Playwright retries, is a
  render-parity spec (none are bundle-size), and none is a MeshLoD scene (MeshLoD is
  tree-shaken from all 216 scenes, so it cannot affect their rendering).

The mandatory suite ran in an **isolated linked worktree that was fully discarded**
afterward. No golden reference, bundle ceiling, or `scene-config.json` threshold was
changed in the working tree; the only committed changes for this task are documentation.
(Self-updating live-capture parity specs rewrite some non-MeshLoD `babylon-ref-golden.png`
files inside the worktree at test time; those transient rewrites are discarded with the
worktree and never reach the repository — which is precisely why the mandatory run is
isolated.)

## 6. Notes

- **Perf is user/CI-only** (`GUIDANCE.md` §0c): `pnpm test:perf` was not run.
- **Pre-existing working-tree state preserved.** `pnpm-lock.yaml` (a
  `pnpm-workspace.yaml` `overrides` security-pin drift) and
  `lab/public/bundle/manifest/scene113|114|115.json` + `demos-manifest.json` were
  already modified before this task and are unrelated to MeshLoD; they are left as-is.
- **No thresholds, goldens, or ceilings changed** by this task.
