# Task Board: Inspector Material and Texture Parity

## Queue

| M | ID | Task | Skill | Notes |
|---|----|------|-------|-------|
| P6 | T-27 | Add adapter operation generations, refresh, errors, and cleanup | execute-implementation-plan | plan T22 |
| P7 | T-28 | Close the focused behavior, accessibility, and refresh matrix | execute-implementation-plan | plan T23 |
| P7 | T-29 | Verify public surface, builds, package isolation, and runtime bytes | execute-implementation-plan | plan T24 |

## Completed

| M | ID | Task | Skill | Notes |
|---|----|------|-------|-------|
| | T-01 | Goals — review or create goals.md | review-goals | done 2026-09-20 · goals.md |
| | T-02 | Visual mocks (optional) | create-html-mock | skipped 2026-09-20 · match Babylon.js Inspector v2 |
| | T-03 | Requirements | write-requirements | done 2026-09-20 · requirements.md |
| | T-04 | Architecture | write-architecture | done 2026-09-21 · architecture.md |
| | T-05 | Implementation plan | write-implementation-plan | done 2026-09-21 · plan.md |
| P0 | T-06 | Freeze public and import-boundary tests | execute-implementation-plan | done 2026-09-21 · expected-red Lite contract tests; Babylon.js boundary in ed06d5cd |
| P1 | T-07 | Add pure inspection value and capability types | execute-implementation-plan | done 2026-09-21 · inspection-types.ts and focused unit coverage |
| P1 | T-08 | Make material rebuild completion awaitable | execute-implementation-plan | done 2026-09-21 · awaited rebuild overload and focused completion/error coverage |
| P1 | T-09 | Implement common material inspection and transaction primitives | execute-implementation-plan | done 2026-09-21 · material-inspection.ts and focused transaction coverage |
| P2 | T-10 | Implement complete Standard material inspection | execute-implementation-plan | done 2026-09-21 · standard-material-inspection.ts and focused matrix/mutation coverage |
| P2 | T-11 | Implement PBR core inspection and feature signatures | execute-implementation-plan | done 2026-09-21 · side-effect-free core descriptor, exact feature-signature U/R planning, and focused matrix/mutation coverage; dispatcher, optional PBR fragments, and texture inspection remain later tasks |
| P2 | T-12 | Add PBR optional-family reconstruction and directional mutation | execute-implementation-plan | done 2026-09-21 · configured-family matrices, public-setter reconstruction, exact directional U/R planning, frame-graph transitions, and focused optional-family coverage |
| P2 | T-13 | Implement declaration-driven Shader material inspection | execute-implementation-plan | done 2026-09-21 · declaration-ordered custom uniforms and samplers, read-only pipeline summary, public-setter A mutations, compatibility validation, and focused no-op/error coverage |
| P2 | T-14 | Implement deterministic Node material inspection | execute-implementation-plan | done 2026-09-21 · lexically ordered public input handles, copied scalar/vector controls, canonical nullable textures, A/R mutation, and focused deterministic/rebuild coverage |
| P2 | T-15 | Wire canonical bindings and preserve legacy texture enumeration | execute-implementation-plan | done 2026-09-21 · root dispatcher, MaterialView/source identity, validated mutations, and legacy canonical-binding projection with focused compatibility/isolation coverage |
| P2 | T-16 | Implement safe texture metadata and consumer-aware transform mutation | execute-implementation-plan | done 2026-09-21 · handle-free metadata, exact-wrapper Standard/PBR invalidation, T-06 contract/isolation green, and zero raw-byte delta in filtered scenes |
| P3 | T-17 | Add an instance-owned Lite scene resource index service | execute-implementation-plan | done 2026-09-21 · BabylonJS/Babylon.js commit fff4e478 · Inspector-owned deterministic source/view/texture index with canonical binding consumers and focused coverage |
| P3 | T-18 | Move Material and Texture Explorer providers onto the index | execute-implementation-plan | done 2026-09-21 · BabylonJS/Babylon.js commit ed601d4e · Material/Texture providers use the index with stable source/wrapper selection identity and stale-resource safety |
| P3 | T-19 | Implement topology refresh and index disposal | execute-implementation-plan | done 2026-09-21 · BabylonJS/Babylon.js commit c609ac9a · coalesced watcher-owned refresh, deterministic notifications, stable ordinals, and idempotent disposal |
| P4 | T-20 | Add shared field models and material section core | execute-implementation-plan | done 2026-09-21 · BabylonJS/Babylon.js commit ed06d5cd · runtime-neutral fields, section core, tests, and import isolation |
| P4 | T-21 | Add direction-aware texture binding property line | execute-implementation-plan | done 2026-09-21 · BabylonJS/Babylon.js commit ed06d5cd · capability-driven assign/replace/clear/navigation with errors and accessibility |
| P4 | T-22 | Add metadata-only texture core and accessible operation errors | execute-implementation-plan | done 2026-09-21 · BabylonJS/Babylon.js commit ed06d5cd · safe metadata rows, navigation, and no preview/editor coupling |
| P5 | T-23 | Adapt Babylon.js material fields and bindings to shared P4 cores | execute-implementation-plan | done 2026-09-21 · BabylonJS/Babylon.js commit ed06d5cd · existing runtime behavior adapted to shared contracts |
| P5 | T-24 | Adapt Babylon.js metadata rows without touching preview/editor | execute-implementation-plan | done 2026-09-21 · BabylonJS/Babylon.js commit ed06d5cd · metadata adapters preserve existing preview/editor ownership |
| P6 | T-25 | Add lazy Lite material family adapters and Properties integration | execute-implementation-plan | done 2026-09-21 · BabylonJS/Babylon.js commit ef36dd5b · lazy Standard/PBR/Shader/Node adapters, index-scoped mutations, exact-wrapper navigation, and focused integration coverage |
| P6 | T-26 | Add Lite metadata-only texture adapter and Properties integration | execute-implementation-plan | done 2026-09-21 · BabylonJS/Babylon.js commit 7814f216 · safe metadata rows, exact consumer navigation, gated transform edits, and no preview/editor coupling |

## Untriaged
