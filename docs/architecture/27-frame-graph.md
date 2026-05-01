# Module: Frame Graph
> Package path: `packages/babylon-lite/src/frame-graph/`
> Related paths: `packages/babylon-lite/src/engine/render-target.ts`, `packages/babylon-lite/src/texture/rtt.ts`, `packages/babylon-lite/src/render/renderable.ts`

## Purpose

The frame graph schedules a scene's render work as an ordered list of tasks. It replaces the old "engine owns one privileged main render pass" model with scene-owned tasks that all encode into the engine's current `GPUCommandEncoder`.

The first implementation is intentionally small:

- a `FrameGraph` is an ordered task list, not a dependency DAG
- `RenderPassTask` is currently the only concrete task type
- the `Task` interface is intentionally open so later work can add other task types
- render targets are explicit objects, not virtual graph resources yet
- the default scene render is itself a `RenderPassTask`

This gives Babylon Lite enough structure for offscreen RTT passes, per-pass cameras, and per-pass material overrides while keeping scheduling explicit, data-oriented, and tree-shakable. If Lite ever gets a node render graph, that higher-level authoring layer may be a DAG, but the executable frame graph remains an ordered list of tasks.

## Public API Surface

```typescript
export type { FrameGraph } from "./frame-graph/frame-graph.js";
export type { Task } from "./frame-graph/task.js";
export { getFrameGraph } from "./scene/scene.js";
export { addTask, addTaskAtStart, addTaskBefore } from "./frame-graph/frame-graph-actions.js";

export type { RenderPassTask, RenderPassTaskConfig } from "./frame-graph/render-pass-task.js";
export { createRenderPassTask, removeMeshFromTask } from "./frame-graph/render-pass-task.js";

export type { RenderTarget, RenderTargetDescriptor } from "./engine/render-target.js";
export { createRenderTarget } from "./engine/render-target.js";
export { createRenderTargetTexture } from "./texture/rtt.js";
```

### `FrameGraph`

```typescript
export interface FrameGraph {
  _tasks: Task[];
  _ready: boolean;
  _engine: EngineContextInternal;
  _scene: SceneContextInternal;
  build(): Promise<void>;
  execute(): number;
  dispose(): void;
}
```

`createSceneContext(engine)` creates a frame graph immediately and appends one default swapchain `RenderPassTask` named `"scene"`. User code normally accesses it through `getFrameGraph(scene)` or passes the scene directly to `addTask*()`.

### `Task`

```typescript
export interface Task {
  readonly name: string;
  readonly engine: EngineContextInternal;
  readonly scene: SceneContextInternal;
  record(): Promise<void> | void;
  execute(): number;
  dispose(): void;
}
```

Task lifecycle:

| Method | Called by | Purpose |
|---|---|---|
| `record()` | `FrameGraph.build()` | Allocate/rebuild GPU resources and finalize descriptors. May be async. |
| `execute()` | `FrameGraph.execute()` once per frame | Encode GPU work into `engine._currentEncoder`. Returns draw-call count. |
| `dispose()` | `FrameGraph.dispose()` | Release task-owned GPU resources. |

At the time of this PR, `RenderPassTask` is the only implementation of `Task`. The interface exists so future frame-graph work can add other ordered task types without changing `FrameGraph` itself, for example compute tasks, copy/resolve tasks, post-process tasks, or resource-transition/helper tasks.

## Task Ordering

Tasks execute in array order. There is no automatic dependency analysis; caller order is the contract.

```typescript
addTask(sceneOrGraph, task);              // append at end
addTaskAtStart(sceneOrGraph, task);       // insert at start
addTaskBefore(sceneOrGraph, task, beforeTask);
```

Rules:

- Offscreen producer tasks must run before consumers that sample their output.
- Overlay tasks should use `clr: false` and run after the task they overlay.
- `addTaskBefore()` appends if the `beforeTask` is not found.
- Adding or inserting a task marks the graph not ready; call `await getFrameGraph(scene).build()` before the next frame if tasks are modified outside the startup/resize path.
- If a pass uses `addToPass()` before `registerScene()`, defer the explicit `build()` call until after `registerScene()` so deferred material builders have run.

## Render Targets

### Descriptor

```typescript
export interface RenderTargetDescriptor {
  label?: string;
  colorFormat: GPUTextureFormat;
  depthStencilFormat?: GPUTextureFormat;
  sampleCount: number;
  size: "canvas" | { width: number; height: number };
  resolveToSwapchain?: boolean;
}
```

Render targets are pure-state descriptors plus owned GPU texture handles. `buildRenderTarget(rt, engine)` allocates textures during `RenderPassTask.record()`.

| Field | Meaning |
|---|---|
| `colorFormat` | Color attachment format; use `engine.format` for swapchain-compatible output. |
| `depthStencilFormat` | Optional depth/stencil attachment format. Most 3D passes use `"depth24plus-stencil8"`. |
| `sampleCount` | `1` or `4`, matching WebGPU limits. Pipelines key on this value. |
| `size` | `"canvas"` follows canvas backing-store size; fixed `{ width, height }` is used for stable RTTs. |
| `resolveToSwapchain` | True for swapchain passes. With MSAA, the task uses an owned MSAA color texture and resolves into the per-frame swapchain view. |

### Target Signature

```typescript
export interface RenderTargetSignature {
  colorFormat: GPUTextureFormat;
  depthStencilFormat?: GPUTextureFormat;
  sampleCount: number;
  flipY?: boolean;
}
```

Material pipelines are cached by target signature. Offscreen render targets set `flipY: true`, because their projection matrix is Y-flipped so the resulting texture samples upright in later passes. Pipeline builders must account for this signature bit when creating culling/front-face state.

### Eager RTT Texture

```typescript
export function createRenderTargetTexture(
  engine: EngineContext,
  descriptor: RenderTargetDescriptor
): { rt: RenderTarget; texture: Texture2D };
```

Use this when a pass output must be wired into a material before the frame graph is built. It eagerly allocates the render target and exposes the color attachment as a `Texture2D`.

Constraints:

- `descriptor.size` must be fixed, not `"canvas"`.
- The render target must own a color texture; `resolveToSwapchain: true` with `sampleCount: 1` is invalid.
- The target is marked eager, so later `buildRenderTarget()` calls do not reallocate and invalidate already-created bind groups.

## `RenderPassTask`

`RenderPassTask` is currently the only concrete frame-graph task. It opens one render pass, writes a per-pass scene UBO, draws renderables, and ends the pass.

```typescript
export interface RenderPassTaskConfig {
  name: string;
  rt: RenderTarget;
  clrColor?: GPUColorDict;
  clr?: boolean;
  cam?: Camera | null;
  cs?: boolean;
}
```

| Field | Meaning |
|---|---|
| `name` | Used for labels and diagnostics. |
| `rt` | Concrete render target for this pass. |
| `clrColor` | Clear color. The object may be mutated between frames. |
| `clr` | Defaults to clear. Set `false` to use color/depth `loadOp: "load"` for overlays or multi-scene composition. |
| `cam` | Optional per-pass camera. Defaults to `scene.camera`. |
| `cs` | Canvas-sized aspect flag. When true, scene UBO aspect uses canvas dimensions instead of RTT dimensions. This is useful for RTTs that are later sampled as a material texture but should preserve canvas aspect. |

### Default Scene Pass

`createSceneContext(engine)` creates:

```typescript
const swapRT = createRenderTarget({
  label: "scene-swapchain",
  colorFormat: engine.format,
  depthStencilFormat: "depth24plus-stencil8",
  sampleCount: engine.msaaSamples,
  size: "canvas",
  resolveToSwapchain: true,
});

createRenderPassTask({ name: "scene", rt: swapRT, clrColor: scene.clearColor }, engine, scene);
```

This task auto-mirrors `scene._renderables` when its own `_renderables` list is empty. If the scene renderable version changes because of mesh add/remove/material swap, the task re-syncs and rebinds its draw lists.

### Explicit Pass Population

A pass can be explicitly populated with:

```typescript
task.addToPass(mesh);
task.addToPass(mesh, { material: overrideMaterial });
```

`addToPass()` resolves at `record()` time through the material family's `_buildGroup._rebuildSingle` hook. The mesh's material family must already be registered with the scene so the builder has run.

If a task has explicit renderables, it does **not** auto-mirror the scene.

### Buckets and Draw Execution

At record/re-sync time, `RenderPassTask` converts renderables into `DrawBinding`s by calling:

```typescript
const binding = renderable.bind(engine, targetSignature);
```

Bindings are partitioned into:

| Bucket | Renderable flags | Execution |
|---|---|---|
| Opaque | `!isTransparent && !isTransmissive` | Cached `GPURenderBundle` |
| Transmissive | `isTransmissive` | Direct draw after opaque |
| Transparent | `isTransparent` | Direct draw after transmissive, sorted back-to-front per frame |

Opaque and transmissive buckets currently sort by `renderable.order`. Transparent is sorted by squared distance from the active pass camera and must not be pipeline-sorted.

`DrawBinding.pipeline` is optional. If present, `drawList()` deduplicates `setPipeline()`. If absent, the binding's draw closure owns pipeline binding and the dedup state is reset.

## Per-Pass Scene UBO

Each `RenderPassTask` owns:

- `_sceneUBO`
- `_sceneBG`
- `_suData` scratch
- `_su` dirty-check cache

`writePassSceneUBO()` writes the canonical 352-byte `SceneUniforms` layout:

| Float offset | Field |
|---:|---|
| 0 | `viewProjection` |
| 16 | `view` |
| 32 | `vEyePosition` |
| 36 | `envRotationY` |
| 40 | spherical harmonics coefficients |
| 76 | `exposureLinear` |
| 77 | `contrast` |
| 78 | `lodGenerationScale` |
| 80 | `vFogInfos` |
| 84 | `vFogColor` |

The writer bails before touching scratch/GPU when camera, fog, aspect, environment rotation, exposure, and contrast are unchanged.

Offscreen targets use `targetSignature.flipY` and negate the projection row so downstream texture sampling is upright. Swapchain targets do not flip.

## Usage: Offscreen Pass Feeding a Material

Scene 52 demonstrates the core pattern:

```typescript
const { rt, texture } = createRenderTargetTexture(engine, {
  label: "r1",
  colorFormat: engine.format,
  depthStencilFormat: "depth24plus-stencil8",
  sampleCount: 1,
  size: { width: 512, height: 512 },
});

const consumerMaterial = createStandardMaterial();
consumerMaterial.diffuseTexture = texture;

const rttCamera = createFreeCamera({ x: 0, y: 0, z: -3 }, { x: 0, y: 0, z: 0 });
const task = createRenderPassTask(
  { name: "r1", rt, cam: rttCamera, clrColor: { r: 0.1, g: 0.1, b: 0.3, a: 1 }, cs: true },
  engine,
  scene
);

addTaskAtStart(scene, task);
task.addToPass(sourceMesh, { material: overrideMaterial });

await registerScene(engine, scene);
await getFrameGraph(scene).build();
await startEngine(engine);
```

Why this works:

1. `createRenderTargetTexture()` eagerly creates the texture so `consumerMaterial` can capture it in its bind group.
2. `addTaskAtStart()` runs the RTT pass before the default scene pass.
3. `addToPass()` renders only the selected mesh into the RTT.
4. The default scene pass later samples the produced texture.

## Scene Removal and Material Swaps

`removeMeshFromTask(task, mesh)` removes a mesh from a task's source renderables and bucketed bindings. Scene removal calls this for frame-graph render-pass tasks so removed meshes do not continue drawing.

Material swaps use the scene material-swap queue and each material builder's `_rebuildSingle` hook. Auto-mirrored render-pass tasks notice `_renderableVersion` changes and rebind their draw lists.

## Resize and Rebuild

`resizeEngine(engine)` updates the canvas backing store and calls each registered rendering context's `_resize()` hook. For scenes, `_resize()` rebuilds the frame graph so canvas-sized render targets are reallocated at the new dimensions.

Fixed-size eager RTTs are not reallocated by graph rebuilds because their GPU texture handles may already be captured by material bind groups.

## Design Boundaries

- The frame graph is intentionally ordered, not dependency-solved. Callers must insert producers before consumers.
- A future node render graph, if implemented in Lite, would be a separate higher-level DAG that emits this ordered task list.
- `RenderPassTask` is the only concrete task today, but new `Task` implementations are expected as frame-graph coverage expands.
- Render targets are concrete objects. There is no virtual resource aliasing or automatic lifetime analysis yet.
- `RenderPassTaskConfig.rt` is intentionally still concrete until texture management is virtualized.
- `addToPass()` relies on material family rebuild hooks and therefore requires the mesh/material family to be part of the scene build.
- Transparent bindings sort by camera distance only; they are not pipeline-batched.

## Babylon.js FrameGraph Mapping

| Babylon.js concept | Babylon Lite |
|---|---|
| Frame graph | Ordered `FrameGraph._tasks` |
| Frame graph task | `Task` |
| Render pass task | `RenderPassTask` |
| Texture/resource handle | Concrete `RenderTarget` for now |
| Task record/build phase | `Task.record()` via `FrameGraph.build()` |
| Per-frame execute phase | `Task.execute()` via `FrameGraph.execute()` |
| Render target texture | `createRenderTargetTexture()` |
| Pass-specific camera/scene UBO | `RenderPassTaskConfig.cam` + task-owned `_sceneUBO` |

## File Manifest

| File | Purpose |
|---|---|
| `src/frame-graph/task.ts` | Polymorphic task interface |
| `src/frame-graph/frame-graph.ts` | Ordered task list and build/execute/dispose lifecycle |
| `src/frame-graph/frame-graph-actions.ts` | Public task insertion helpers |
| `src/frame-graph/render-pass-task.ts` | Render-pass task, per-pass scene UBO, target binding, draw buckets |
| `src/engine/render-target.ts` | Render target descriptors, allocation, disposal, target signatures |
| `src/texture/rtt.ts` | Eager render-target texture helper |
| `src/render/renderable.ts` | `Renderable` and `DrawBinding` contracts consumed by render-pass tasks |
