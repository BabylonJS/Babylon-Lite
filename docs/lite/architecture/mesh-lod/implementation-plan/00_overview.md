# MeshLoD - Implementation Plan

> Historical implementation plan. The converter source and build commands formerly under
> `mesh-lod-tool/` now live at the root of [MegameshCLI](https://github.com/CedricGuillemet/MegameshCLI).
> Current workflows and CLI commands are in the [Lite README](../../../../../README.md) and
> [CLI README](https://github.com/CedricGuillemet/MegameshCLI#readme). Local all-scene
> and visual/parity runs mentioned below are reserved for CI or an explicit user request.

## Summary

MeshLoD adds a deterministic native converter, a range-addressable `.mlod` format, an opt-in Babylon Lite runtime, material-owned indirect WebGPU rendering, bounded streaming/cache behavior, lifecycle recovery, and a diagnostic statue demo. The plan is ordered as vertical milestones so each phase produces a testable artifact and later GPU/streaming work is checked against accepted CPU and binary-format oracles.

## Phases

- **Phase 1: Native converter core** — configure pinned dependencies, normalize supported glTF primitives, and produce validated clustered hierarchy data.
- **Phase 2: Deterministic format and statue assets** — encode the exact v1 binary contract, validate it, and generate the three statue sidecars.
- **Phase 3: TypeScript format and CPU oracle** — establish runtime parsing, protocol validation, and deterministic reference selection.
- **Phase 4: Lazy loading and coarse rendering** — make validated pinned geometry render through the public opt-in path before fine streaming.
- **Phase 5: GPU selection and indirect materials** — move selection/expansion to compute while preserving material ownership and CPU equivalence.
- **Phase 6: Streaming and cache** — add bounded page requests, residency transitions, and deterministic eviction.
- **Phase 7: Lifecycle** — make disposal, resource retirement, sharing, and device recovery safe.
- **Phase 8: Demo and diagnostics** — ship the production-path statue demo, controls, diagnostics, and fallback demonstrations.
- **Phase 9: Full validation** — complete requirement traceability and run every agent-allowed guardrail, including mandatory `pnpm test`.

## Phase Rationale

The converter and binary format come first because every runtime fixture depends on deterministic bytes. The TypeScript parser and CPU selector become correctness oracles before any GPU implementation. Coarse rendering is delivered before streaming so the always-renderable fallback can be tested independently. Streaming and lifecycle are layered onto an already-correct render path, and the demo is last so it exercises production APIs rather than becoming an alternate implementation.

## Task Index

| File | Task | Phase | Requirements |
| --- | --- | ---: | --- |
| `01_01_scaffold_converter.md` | Scaffold converter and pin dependencies | 1 | REQ-NAME-2, REQ-TOOL-1, REQ-TOOL-2, REQ-TOOL-6 |
| `01_02_cli_and_primitive_selection.md` | Implement CLI and primitive selection | 1 | REQ-TOOL-5, REQ-TOOL-9, REQ-GEO-6 |
| `01_03_normalize_gltf_geometry.md` | Normalize supported glTF geometry | 1 | REQ-TOOL-3, REQ-GEO-1..4 |
| `01_04_build_cluster_hierarchy.md` | Build clustered hierarchy and meshlets | 1 | REQ-TOOL-4, REQ-GEO-5..7 |
| `02_01_define_binary_contract.md` | Define binary structs and integrity utilities | 2 | REQ-FMT-1, REQ-FMT-5, REQ-FMT-6 |
| `02_02_pack_deterministic_pages.md` | Pack deterministic geometry pages | 2 | REQ-TOOL-7, REQ-FMT-3, REQ-FMT-4 |
| `02_03_write_validate_publish.md` | Write, validate, and atomically publish `.mlod` | 2 | REQ-TOOL-8, REQ-FMT-2, REQ-FMT-6 |
| `02_04_converter_fixtures_and_statue.md` | Add converter fixtures and generate statue assets | 2 | REQ-NAME-3, REQ-VERIFY-1 |
| `03_01_public_api_and_errors.md` | Add public state APIs and stable errors | 3 | REQ-INT-1, REQ-INT-3..6 |
| `03_02_parse_mlod_buffers.md` | Parse and validate complete buffers | 3 | REQ-FMT-1, REQ-FMT-5, REQ-FMT-6 |
| `03_03_range_source_bootstrap.md` | Implement range-source bootstrap protocol | 3 | REQ-FMT-2, REQ-FMT-3, REQ-FMT-7 |
| `03_04_cpu_selection_oracle.md` | Implement deterministic CPU oracle | 3 | REQ-SEL-1, REQ-SEL-3..7 |
| `04_01_lazy_page_decoder.md` | Share lazy meshopt page decoder | 4 | REQ-INT-2, REQ-INT-8 |
| `04_02_load_pinned_pages.md` | Load metadata and pinned coarse pages | 4 | REQ-LOAD-1, REQ-LOAD-2, REQ-CACHE-2 |
| `04_03_scene_registry_cpu_selection.md` | Add lazy scene registry and CPU selection | 4 | REQ-INT-4, REQ-INT-7, REQ-SEL-7 |
| `04_04_pbr_coarse_indirect_rendering.md` | Render coarse PBR batches indirectly | 4 | REQ-RENDER-1..3 |
| `04_05_verify_lazy_coarse_path.md` | Verify lazy loading and coarse fallback | 4 | REQ-VERIFY-2, REQ-VERIFY-5 |
| `05_01_gpu_metadata_buffers.md` | Create persistent GPU metadata buffers | 5 | REQ-SEL-2, REQ-RENDER-4 |
| `05_02_gpu_selection_compute.md` | Implement GPU selection and demand compute | 5 | REQ-SEL-2..6, REQ-STREAM-5 |
| `05_03_gpu_expansion_indirect_draw.md` | Expand clusters and issue indirect draws | 5 | REQ-RENDER-1..4 |
| `05_04_cpu_gpu_equivalence.md` | Prove CPU/GPU and render equivalence | 5 | REQ-VERIFY-3, REQ-RENDER-2 |
| `06_01_page_request_scheduler.md` | Implement page request scheduler | 6 | REQ-STREAM-1..6 |
| `06_02_bounded_page_caches.md` | Implement bounded CPU/GPU caches | 6 | REQ-CACHE-1..4 |
| `06_03_connect_streaming_residency.md` | Connect demand, streaming, and residency | 6 | REQ-SEL-6, REQ-SEL-7, REQ-LOAD-2 |
| `06_04_streaming_cache_fixtures.md` | Verify streaming/cache invariants | 6 | REQ-VERIFY-4 |
| `07_01_disposal_and_scene_pruning.md` | Implement disposal and scene pruning | 7 | REQ-LOAD-3, REQ-INT-7 |
| `07_02_deferred_device_recovery.md` | Add generic deferred device recovery | 7 | REQ-LOAD-4, REQ-RENDER-4 |
| `07_03_lifecycle_recovery_fixtures.md` | Verify frame-safe lifecycle recovery | 7 | REQ-LOAD-3, REQ-LOAD-4 |
| `08_01_demo_shell_and_assets.md` | Build demo shell and asset packaging | 8 | REQ-DEMO-1..3 |
| `08_02_demo_controls_network_camera.md` | Add controls, network simulation, and camera path | 8 | REQ-DEMO-3, REQ-DEMO-4 |
| `08_03_demo_diagnostics_debug.md` | Add diagnostics, debug views, and fallback scenarios | 8 | REQ-DEMO-5..7 |
| `08_04_verify_demo_workflows.md` | Verify standalone demo workflows | 8 | REQ-VERIFY-6 |
| `09_01_full_validation_traceability.md` | Complete full validation and traceability | 9 | REQ-INT-8, REQ-VERIFY-1..6 |
