# Module: Renderable + Frame-Graph Architecture

> Package paths: `packages/babylon-lite/src/render/renderable.ts`, `packages/babylon-lite/src/frame-graph/`

## Purpose

The render pipeline is driven by a scene-owned frame graph. Materials still own shaders, pipelines, and bind groups; the frame graph only schedules render passes and asks material renderables to bind target-specific draw closures.

This keeps the engine render loop material-agnostic while allowing the same `Renderable` to participate in multiple passes with different target signatures (swapchain, RTT, MSAA count, Y-flip).

## Public API Surface

### Renderable contract (`render/renderable.ts`)

```typescript
export interface DrawUpdateContext {
    readonly targetWidth: number;
    readonly targetHeight: number;
    readonly _camera?: Camera | null;
}

export interface DrawBinding {
    readonly renderable: Renderable;
    readonly pipeline: GPURenderPipeline;
    draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder, engine: EngineContext): number;
    update?(context: DrawUpdateContext): void;
    _sortDistance?: number;
}

export interface Renderable {
    readonly order: number;
    readonly isTransparent: boolean;
    readonly isTransmissive?: boolean;
    readonly _direct?: boolean;
    readonly mesh?: Mesh;
    _sortDistance?: number;
    _worldCenter?: [number, number, number];
    _lastMaterial?: any;
    bind(engine: EngineContext, target: RenderTargetSignature): DrawBinding;
}

export interface PrePassRenderable {
    execute(encoder: GPUCommandEncoder, engine: EngineContext): number;
}

export interface MeshGroupBuildResult {
    renderables: Renderable[];
    updater?: SceneUniformUpdater;
    rebuildSingle: (scene: any, mesh: any, materialOverride?: any) => Renderable;
}
```

`Renderable.bind(engine, target)` is the key split: material modules resolve the pipeline for the pass target once and return a `DrawBinding` closure. The `RenderTask` owns the scene bind group (group 0), so renderables never set bind group 0 themselves.

`DrawBinding.update(context)` is called once per frame per binding before the render pass is opened. The context contains the current pass target dimensions (`targetWidth`, `targetHeight`) and the active pass camera (`_camera`) so bindings can refresh target-size-dependent UBOs or camera-sorted instance buffers without rebuilding their pipelines or bind groups. Mesh/material UBO updates that do not need the target dimensions still use this hook and version-guard their writes.

### Frame graph (`frame-graph/`)

```typescript
export interface Task {
    readonly name: string;
    readonly engine: EngineContextInternal;
    readonly scene: SceneContextInternal;
    _passes: Pass[];
    record(): void;
    dispose(): void;
}

export interface FrameGraph {
    _tasks: Task[];
    _ready: boolean;
    build(): void;
    execute(): number;
    dispose(): void;
}
```

`createSceneContext()` eagerly creates a `FrameGraph` with one default `RenderTask` named `"scene"` that renders into the swapchain. User code can add tasks with `addTask()`, `addTaskAtStart()`, or `addTaskBefore()`.

### RenderTask

`RenderTask` begins a WebGPU render pass, buckets/binds renderables, writes its per-task scene UBO, draws, and ends the pass.

```typescript
export interface RenderTaskConfig {
    name: string;
    rt: RenderTarget;
    clrColor?: GPUColorDict;
    clr?: boolean;
    cam?: Camera | null;
    cs?: boolean;
}
```

Important fields:

| Field | Meaning                                                                                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `rt`  | Concrete render target. Swapchain tasks use `resolveToSwapchain: true`; RTT tasks allocate color/depth textures.                    |
| `clr` | `true`/undefined clears color+depth; `false` loads previous content for overlays/multi-scene composition.                           |
| `cam` | Per-pass camera override; defaults to `scene.camera`.                                                                               |
| `cs`  | Use canvas dimensions for scene UBO aspect instead of RTT dimensions. Used when an RTT texture must be rendered with canvas aspect. |

## Runtime Flow

```text
createSceneContext(engine)
  -> createFrameGraph(engine, scene)
  -> append default swapchain RenderTask
  -> build frame graph

startEngine/registerScene frame:
  scene._update()
    -> before-render callbacks
    -> material swap processing
    -> shadow generators and legacy pre-passes
    -> shared uniform updaters
  scene._record()
    -> frameGraph.execute()
      -> _executeTask(task)
        -> each pass._execute()
```

`FrameGraph.build()` calls `record()` on every task. `record()` is where `RenderTask` builds the render target, stores the current target dimensions in its update context, builds the pass descriptor, auto-fills from scene renderables when `_renderables` is empty, resolves pending `addMesh()` material overrides, and creates per-target `DrawBinding` lists.

## RenderTask Buckets

At record/re-sync time, a render pass task partitions bindings into:

| Bucket      | Source flag                  | Draw path                                                           |
| ----------- | ---------------------------- | ------------------------------------------------------------------- |
| Opaque      | `!isTransparent && !_direct` | Cached `GPURenderBundle` when visibility/version state is unchanged |
| Direct      | `_direct`                    | Direct draw after opaque bundle                                     |
| Transparent | `isTransparent`              | Direct draw, distance-sorted back-to-front per pass                 |

Opaque and direct bindings are sorted by `renderable.order`. Transparent bindings must remain distance-sorted and are not pipeline-sorted. `_direct` selects the non-transparent direct-draw bucket; PBR transmissive renderables set `_direct` and `isTransmissive`, while mutable depth-writing sprite/billboard batches set `_direct` without `isTransmissive` so they still appear in the opaque-scene refraction RTT.

## Per-Pass Scene UBO

Each `RenderTask` owns:

- `_sceneUBO`
- `_sceneBG`
- scene UBO scratch/cache arrays

`writePassSceneUBO()` writes the canonical 352-byte `SceneUniforms` struct for the pass. Offscreen render targets use a Y-flipped projection so downstream texture sampling is upright. Swapchain tasks do not flip. The task-level UBO lets RTT passes, canvas passes, and camera overrides coexist without mutating global scene state.

## Material-Owned Pipelines

Material renderable builders remain responsible for:

1. Computing feature bits from mesh/material/scene state
2. Dynamically importing needed shader fragments
3. Composing WGSL
4. Creating/caching pipelines and bind group layouts
5. Returning renderables whose `bind(engine, target)` selects the correct pipeline for that target signature

The frame graph never imports material-specific shader code.

## `_buildGroup` Pattern

Materials carry `_buildGroup: MeshGroupBuilder` on their props. `addToScene()` groups meshes by builder, and deferred builders run before rendering to produce renderables.

`MeshGroupBuildResult.rebuildSingle` is also stored on the builder as `_rebuildSingle`, so material swaps and `RenderTask.addMesh(mesh, { material })` can rebuild one mesh with an optional per-pass material override.

## Babylon.js Equivalence Map

| Babylon Lite                      | Babylon.js                                        |
| --------------------------------- | ------------------------------------------------- |
| `FrameGraph` + `Task`             | Frame graph / render graph scheduling             |
| `RenderTask`                      | Render pass task that binds target + camera state |
| `Renderable.bind()`               | Material/effect submesh binding for a target      |
| `DrawBinding`                     | Prepared draw item / submesh draw packet          |
| Task-owned scene UBO              | Per-pass scene uniform state                      |
| Opaque/direct/transparent buckets | Rendering group draw lists                        |
| `renderable.order`                | Rendering order / group sorting                   |

## Dependencies

- `render/renderable.ts` imports only engine/mesh/render-target types.
- `frame-graph/frame-graph.ts` depends on `Task`, `EngineContextInternal`, and `SceneContextInternal`.
- `frame-graph/render-task.ts` depends on render targets, camera matrices, canonical scene UBO helpers, and the `Renderable`/`DrawBinding` contracts.
- Material modules depend on `Renderable` and return target-bindable renderables; the frame graph does not depend on material modules.

## File Manifest

| File                                     | Purpose                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/render/renderable.ts`               | `Renderable`, `DrawBinding`, `PrePassRenderable`, optional `SceneUniformUpdater`, `MeshGroupBuildResult`, `MeshGroupBuilder` |
| `src/frame-graph/task.ts`                | Polymorphic frame-graph task interface                                                                                       |
| `src/frame-graph/frame-graph.ts`         | Ordered task list, build/execute/dispose lifecycle                                                                           |
| `src/frame-graph/frame-graph-actions.ts` | `addTask`, `addTaskAtStart`, `addTaskBefore` helpers                                                                         |
| `src/frame-graph/render-task.ts`         | Render task implementation, per-pass scene UBO, renderable bucketing, RTT/swapchain pass execution                           |
