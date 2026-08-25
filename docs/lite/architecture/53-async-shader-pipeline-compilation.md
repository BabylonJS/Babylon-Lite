# Module: Async ShaderMaterial Pipeline Compilation

> Package path: `packages/babylon-lite/src/material/shader/`

## Purpose

This opt-in prepares ShaderMaterial render pipelines before `FrameGraph.build()` or before a caller-defined readiness boundary. It moves WebGPU pipeline compilation off the first synchronous `Renderable.bind()` without changing pixels, pipeline keys, descriptors, or the synchronous fallback. Standard, PBR, NodeMaterial, geometry-material, post-process, and effect pipelines are outside this module.

## Public API Surface

```ts
type ShaderMaterialPipelineLayout = "mesh" | "thin-instances" | "thin-instances-color";

function enableAsyncShaderPipelineCompilation(engine: EngineContext): void;

function prepareShaderMaterialPipeline(engine: EngineContext, material: ShaderMaterial, layout: ShaderMaterialPipelineLayout, target: RenderTarget | RenderTask): Promise<void>;

function prepareShaderMaterialPipelineForTask(task: RenderTask, material: ShaderMaterial, layout: ShaderMaterialPipelineLayout): Promise<void>;
```

`enableAsyncShaderPipelineCompilation` is idempotent. It must be called before ShaderMaterial renderables are built when automatic scene-registration preparation is desired. `prepareShaderMaterialPipeline` and `prepareShaderMaterialPipelineForTask` are explicit preparation queries and do not require a renderable or a prior `addMesh`.

The layout values mean:

- `mesh`: the vertex buffers declared by `ShaderMaterial.attributes`.
- `thin-instances`: those mesh buffers plus four instance-rate `float32x4` matrix rows at consecutive shader locations.
- `thin-instances-color`: the thin-instance matrix layout plus one instance-rate `float32x4` color.

No public API accepts a `GPUDevice`, `GPURenderPipelineDescriptor`, shader module, pipeline layout, or vertex-buffer descriptor.

## Internal Architecture

`shader-pipeline.ts` remains the single owner of ShaderMaterial pipeline identity and construction. Async preparation invokes the unchanged synchronous builder against a transient capture device that delegates shader-module creation to the real device and intercepts only `createRenderPipeline(descriptor)`. The placeholder pipeline is removed from the completed cache synchronously, before control can yield, and the captured descriptor is submitted to the real device through `createRenderPipelineAsync`.

This guarantees that both paths derive the same variant key, shader modules, final cache key, and complete `GPURenderPipelineDescriptor` without adding a branch or descriptor abstraction to the ordinary first-bind path. Both publish the result into the same `ShaderPipelineBindings.pipelines` map.

Automatic thin-instance registration records the mesh plus its logical matrix-only or matrix-and-color layout in the parent ShaderMaterial builder before the lazy thin module is loaded. Preparation resolves that logical layout inside the opt-in module. Explicit preparation uses the same resolver. Scenes that do not import the enabler retain none of the registrar branch, explicit resolver, or descriptor-capture code.

Each bindings object may lazily own an internal pending-pipeline map. It is allocated only when async preparation is used. One promise is retained per final pipeline key. Concurrent requests for the same key await that promise. The entry is removed on fulfillment or rejection. A synchronous bind remains available throughout; if it wins a race, its pipeline remains authoritative in the shared completed cache.

Automatic scene-registration preparation is best-effort. Rejections are reported through `console.error` and do not abort frame-graph construction or scene registration; the first bind then uses the unchanged synchronous path. Explicit preparation APIs reject so callers that define their own readiness boundary can handle the failure directly.

The ShaderMaterial renderable module exposes an install-only registrar setter. The enabler installs one callback globally and owns a `WeakMap` per enabled engine. Ordinary renderables are keyed by renderable identity; thin-instance recipes are keyed by mesh identity so the lazy thin module needs no feature hook. Rollup removes the registrar and all calls when the enabler is absent.

Recipes retain only `ShaderMaterial` plus the already-computed logical pipeline additions. Preparation always resolves current-device bindings at execution time. It therefore cannot reuse a bind-group layout, pipeline layout, module, or pipeline map from a lost device.

Before preparation, the opt-in module retargets an installed cross-material cache to the current GPU device. It then resolves bindings and modules normally. The ordinary synchronous path remains byte-equivalent for scenes that do not import the feature.

## Pipeline Configuration

The prepared descriptor is exactly the descriptor used by synchronous ShaderMaterial rendering:

- vertex entry point: `mainVertex`;
- optional fragment entry point: `mainFragment`;
- group 0: scene bind-group layout;
- group 1: ShaderMaterial bind-group layout;
- topology and culling: material values;
- color format and blend: target and material values;
- depth/stencil format, comparison, writes, bias, and stencil: target and material values;
- sample count and alpha-to-coverage: target signature plus the installed material resolver.

Depth-only targets omit the fragment stage unless `depthOnlyFragment` is set. A `RenderTask` supplies its retained `_targetSignature`, including a separate depth target's format and comparison. A `RenderTarget` signature is derived from its descriptor's color format, depth format, depth comparison, and sample count. Callers using a task with a separate depth attachment must pass the `RenderTask`, not only its color target.

## Shader Logic

No fragment or vertex math changes. For thin instances, the owner appends these inputs after the material's declared attributes:

```wgsl
world0: vec4<f32>
world1: vec4<f32>
world2: vec4<f32>
world3: vec4<f32>
instanceColor: vec4<f32> // only for thin-instances-color
```

Their shader locations begin at `material.attributes.length`. Matrix data uses one instance-rate buffer with stride 64 and offsets 0, 16, 32, and 48. Color uses a second instance-rate buffer with stride 16 and offset 0.

## State Machine / Lifecycle

1. The caller optionally enables automatic preparation on the engine.
2. Opaque, transparent, and thin ShaderMaterial renderable creation registers logical recipes through the installed module-local callback.
3. Scene registration builds deferred scene content and awaits every top-level task `_preload`.
4. The preparation hook materializes pending RenderTask meshes and shadow task states, then traverses top-level tasks plus internal `_task`, `_tasks`, and `_staticTasks` owners.
5. Each ShaderMaterial recipe is prepared for each RenderTask signature. Duplicate final keys share one pending promise.
6. Scene registration awaits all preparation, then calls `FrameGraph.build()`; normal binding finds completed pipelines.
7. Runtime-only renderables or signatures not prepared beforehand use the unchanged synchronous fallback.

PCF and ESM expose one internal RenderTask through their shadow state. CSM exposes a composite `_task` and its cascade `_tasks`; the opt-in CSM static cache additionally exposes `_staticTasks`. Shadow states are materialized only when the scene owns the top-level `shadow` task.

After device loss, recipes remain logical. Current-device bindings and the current-device cross-material cache are resolved only when preparation runs. No old-device binding is authoritative.

## Babylon.js Equivalence Map

Babylon.js may compile render pipelines asynchronously before first use. Lite exposes the same scheduling capability only for ShaderMaterial and retains Lite's existing material-owned descriptor, cache, and synchronous bind behavior. This module changes when compilation occurs, not the pipeline state or shader result.

## Dependencies

- `scene/scene-core.ts`: awaited preparation boundary after task preloads and before frame-graph build.
- `frame-graph/render-task.ts`: exact task signature and pending-mesh resolution.
- `frame-graph/shadow-inputs.ts`: registered shadow caster sets.
- `material/shader/shader-pipeline.ts`: synchronous descriptor/key construction and completed/pending caches.
- `material/shader/shader-pipeline-cache.ts`: device-relative cross-material caches.
- `material/shader/shader-renderable.ts`: opaque and transparent recipe feeds.
- `material/shader/shader-thin-instance.ts`: thin layout selection and recipe feed.

## Test Specification

Focused tests must prove:

1. the feature is inert until enabled;
2. opaque, transparent, thin matrix-only, and thin color recipes prepare the same key and descriptor consumed by synchronous bind;
3. duplicate recipes and duplicate tasks call `createRenderPipelineAsync` once per final key;
4. rejection removes the pending entry and a later synchronous bind still creates its pipeline;
5. registration awaits preparation after task preloads and before `FrameGraph.build()`;
6. explicit preparation works before any renderable or `addMesh` exists;
7. RenderTarget and RenderTask target signatures select the intended color, depth, comparison, and sample state;
8. PCF, ESM, default CSM, and cached CSM internal tasks are traversed, including `_tasks` and `_staticTasks`;
9. plain registration does not materialize unused shadow states;
10. after switching to a second GPUDevice, both plain and cross-material-cache paths allocate new bindings/modules/pipelines and never read the first device's GPU objects;
11. Standard, PBR, NodeMaterial, geometry, post-process, and effect pipeline creation counts are unchanged.

## File Manifest

- `packages/babylon-lite/src/material/shader/enable-async-shader-pipeline-compilation.ts`
- `packages/babylon-lite/src/material/shader/shader-pipeline.ts`
- `packages/babylon-lite/src/material/shader/shader-pipeline-cache.ts`
- `packages/babylon-lite/src/material/shader/shader-renderable.ts`
- `packages/babylon-lite/src/material/shader/shader-thin-instance.ts`
- `packages/babylon-lite/src/scene/scene-core.ts`
- `packages/babylon-lite/src/index.ts`
