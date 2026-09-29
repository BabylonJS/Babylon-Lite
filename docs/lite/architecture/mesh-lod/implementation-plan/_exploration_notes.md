# MeshLoD Exploration Notes

## Repository rules

- `GUIDANCE.md:17-35` requires strict TypeScript, complete tree shaking, no import-time side effects, and lazy device-keyed caches.
- `GUIDANCE.md:37-78` requires one-way scene ownership, pure state public interfaces, no raw WebGPU handles in public APIs, material-owned shaders, and extension seams rather than core feature branches.
- `GUIDANCE.md:147-156` requires `pnpm test` for engine/runtime changes and forbids agent execution of performance tests.
- `GUIDANCE.md:274-291` defines lint/typecheck commands and formatting rules.

## Existing integration points

- `packages/babylon-lite/src/scene/scene-core.ts:49-160` defines `SceneContext`; optional MeshLoD state belongs here as `@internal` fields.
- `packages/babylon-lite/src/scene/scene-core.ts:282-300` provides `DeferredSceneRenderables` and `addDeferredSceneRenderables`, the correct lazy scene-hosted renderable seam.
- `packages/babylon-lite/src/scene/scene-core.ts:428-470` drains deferred builders before frame-graph construction.
- `packages/babylon-lite/src/engine/device-lost-recovery.ts:238-261` clears/rebuilds ordinary renderables and needs a generic deferred-recoverable hook, not a MeshLoD branch.
- `packages/babylon-lite/src/render/renderable.ts:17-29` defines `DrawUpdateContext` and feature-owned `DrawUpdateBatch`.
- `packages/babylon-lite/src/render/renderable.ts:39-88` defines `DrawBinding`/`Renderable`; material renderables own pipelines and draw closures.
- `packages/babylon-lite/src/frame-graph/render-task.ts:160-162,210-237` keeps task-local update batches that flush before drawing.
- `packages/babylon-lite/src/mesh/thin-instance-gpu-culling.ts:220-273` is the closest compute-batch precedent: lazy `WeakMap`, `reset/flush/destroy`, one compute pass.
- `packages/babylon-lite/src/engine/gpu-resource-retirement.ts:5-20` is the make-before-break retirement seam.
- `packages/babylon-lite/src/material/pbr/pbr-material.ts:32-51` lazily imports the PBR renderable builder.
- `packages/babylon-lite/src/material/pbr/pbr-renderable.ts:62-240` resolves optional material features dynamically and owns PBR renderable construction.
- `packages/babylon-lite/src/material/pbr/pbr-compose.ts:84-220` composes shader fragments with a per-scene cache; MeshLoD needs a separate PBR-owned vertex-processing composition path.
- `packages/babylon-lite/src/loader-gltf/meshopt-decode.ts:20-59` lazily loads `/meshopt_decoder.js`; only its decoder interface typing must be shared.
- `packages/babylon-lite/src/index.ts:1-824` is the public barrel. MeshLoD exports should be grouped in one opt-in section and re-export the facade only.
- `packages/babylon-lite/package.json:8-37` defines package subpaths; an internal testing subpath may expose CPU-oracle fixtures without polluting public declarations.

## Demo and testing patterns

- `lab/lite/src/demos/mosquito-amber.ts:40-121` shows engine/scene/camera setup, lazy decoder configuration, loading progress, `registerScene`, `startEngine`, and canvas ready attributes.
- `lab/lite/demo-mosquito-amber.html:44-114` shows the standalone loading overlay and `data-ready`/`data-error` contract.
- `lab/lite/src/demos/loading-progress.ts:71-258` wraps fetch and restores it through an idempotent `done`.
- `scripts/bundle-demos-core.ts:202-282` copies per-demo assets and writes standalone HTML; MeshLoD needs a dedicated `lab/public/mesh-lod` copy branch.
- `scripts/bundle-demos-core.ts:285-367` builds each demo from `lab/lite/src/demos/<slug>.ts`.
- `tests/lite/unit/thin-instance-gpu-culling.test.ts:58-217` demonstrates mocked WebGPU compute and indirect-buffer assertions.
- `tests/lite/unit/gpu-resource-retirement.test.ts:35-145` demonstrates frame-safe retirement tests.
- `tests/lite/unit/device-lost-geometry-sharing.test.ts:55-97` demonstrates retained CPU data and shared-resource recovery tests.
- `vitest.config.ts:11-29` currently includes unit and build projects only; the planned `tests/lite/integration/mesh-lod` suite needs an explicit project.
- `tests/lite/parity/bundle-size.spec.ts:72-168` records runtime chunks and is the correct place for an explicit non-MeshLoD chunk absence assertion.

## Architecture constants

- Converter pins: meshoptimizer `f843aae0b3070306bd2aeef43ffcf09509fee526`; cgltf `85cd62382dfea638278962690cf515023f33ed00`.
- Format: v1.0, little-endian, 256-byte header, 64-byte section entries/groups/clusters/page records/page headers, 32-byte hierarchy nodes, 64-byte metadata alignment, 64 KiB page alignment.
- Required sections: provenance JSON, groups, clusters, hierarchy nodes, group-page refs, page table, page data.
- Decoded vertex stride: 24 bytes; local indices are `u16`.
- Runtime defaults: 2 px SSE, 15% LOD hysteresis, 120-frame residency hold, two-frame obsolete grace, 128 MiB GPU budget/capacity, 64 MiB CPU page cache, four requests, retries at 250/1000 ms.
- One `.mlod` contains one primitive. The statue conversion emits three deterministic sibling files.
