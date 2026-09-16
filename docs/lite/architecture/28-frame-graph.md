# Module: Frame Graph

> Package path: `packages/babylon-lite/src/frame-graph/`
> Related paths: `packages/babylon-lite/src/engine/render-target.ts`, `packages/babylon-lite/src/texture/rtt.ts`, `packages/babylon-lite/src/render/renderable.ts`

## Purpose

The frame graph schedules a scene's render work as an ordered list of tasks. It replaces the old "engine owns one privileged main render pass" model with scene-owned tasks that all encode into the engine's current `GPUCommandEncoder`.

The first implementation is intentionally small:

- a `FrameGraph` is an ordered task list, not a dependency DAG
- `RenderTask` is the default scene-render task type; `EffectRenderTask` is also a frame-graph task for fullscreen RTT effects
- `ShadowTask` is an internal adapter task, installed only by `registerSceneWithShadowSupport()`, that schedules shadow generators through `Task.execute()` before the default scene render
- the `Task` interface is intentionally open so later work can add other task types
- pass-backed tasks record one or more `Pass` instances during `record()`; only `RenderPass` exists today
- built-in tasks may implement `execute()` directly; `RenderTask`, `ShadowTask`, and several fullscreen/effect tasks use this fast path
- render targets are explicit objects, not virtual graph resources yet
- the default scene render is itself a `RenderTask`

This gives Babylon Lite enough structure for offscreen RTT passes, per-pass cameras, and per-pass material overrides while keeping scheduling explicit, data-oriented, and tree-shakable. If Lite ever gets a node render graph, that higher-level authoring layer may be a DAG, but the executable frame graph remains an ordered list of tasks.

## Public API Surface

```typescript
export type { FrameGraph } from "./frame-graph/frame-graph.js";
export type { Task } from "./frame-graph/task.js";
export { getFrameGraph } from "./scene/scene.js";
export { addRenderPass, addTask, addTaskAtStart, addTaskBefore, addTaskAfter } from "./frame-graph/frame-graph-actions.js";

export type { Pass } from "./frame-graph/pass.js";
export { addPassDependencies } from "./frame-graph/pass.js";
export type { RenderPass } from "./frame-graph/render-pass.js";
export type { RenderPassExecuteFunc } from "./frame-graph/pass.js";

export type { RenderTask, RenderTaskConfig } from "./frame-graph/render-task.js";
export { createRenderTask, addMeshToTask, removeMeshFromTask } from "./frame-graph/render-task.js";
export { enableRenderTaskMeshRefresh } from "./frame-graph/render-task-mesh-refresh.js";
export type { OverdrawCostMeasure } from "./engine/gpu-task-timing.js";
export { measureRenderTaskOverdrawCost } from "./engine/gpu-task-timing.js";
export type { ImageProcessingSource, ImageProcessingTaskConfig } from "./frame-graph/image-processing-task.js";
export { createImageProcessingTask } from "./frame-graph/image-processing-task.js";

export type { RenderTarget, RenderTargetDescriptor } from "./engine/render-target.js";
export { createRenderTarget } from "./engine/render-target.js";
export type { RenderTargetDepthSampler, RenderTargetTextureResult } from "./texture/rtt.js";
export { createRenderTargetTexture, disposeRenderTargetTexture } from "./texture/rtt.js";
export { createSurfaceRenderTargetTexture, onRenderTargetTextureResize } from "./texture/rtt-surface.js";
export { withSampledDepthTexture } from "./texture/rtt-depth.js";
```

### `FrameGraph`

```typescript
export interface FrameGraph {
    _tasks: Task[];
    _currentProcessedTask: Task | null;
    build(): void;
    execute(): number;
    dispose(): void;
}
```

`createSceneContext(engine, options?)` creates a frame graph immediately and appends one default swapchain `RenderTask` named `"scene"` unless `options.defaultRenderTask === false`. Post-process pipelines that render the scene to an offscreen source and resolve their final fullscreen pass to the swapchain disable the default task to avoid a duplicate scene render. `registerSceneWithShadowSupport()` inserts the internal shadow adapter task named `"shadow"` at the front, while ordinary `registerScene()` stays shadow-free so non-shadow scenes do not retain the shadow task module. User code normally accesses the graph through `getFrameGraph(scene)` or passes the scene directly to `addTask*()`.

`build()` runs in two phases (mirroring the implicit shape of BJS' `frameGraph.buildAsync`):

1. **Record.** For each task in execute order: clear `task._passes`, set `_currentProcessedTask = task`, call `task.record()`, then unset the cursor in `finally`. The cursor lets `addRenderPass(...)` inside `record()` associate a freshly-created `Pass` with the task that is currently recording.
2. **Initialize.** For each task in execute order, for each pass: call `pass._initialize()`. This deferred initialization lets a pass safely reference resources allocated by _other_ tasks (for example, an RTT whose color texture is built by an earlier task's `record()`).

`_currentProcessedTask` is `null` outside of phase 1; calling `addRenderPass(...)` outside `record()` throws.

### `Task`

```typescript
export interface Task {
    readonly name: string;
    executionEnabled?: boolean;
    readonly engine: EngineContext;
    readonly scene?: SceneContext;
    _passes: Pass[];
    record(): void;
    _preload?(): Promise<void>;
    _removeMesh?(mesh: object): void;
    execute?(): number;
    dispose(): void;
}
```

Task lifecycle:

| Method      | Called by                      | Purpose                                                                                                                                                |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `record()`  | `FrameGraph.build()` (phase 1) | Allocate/rebuild GPU resources and optionally register `Pass` instances onto `_passes`. Direct tasks instead prepare their own descriptor/state. Sync. |
| `execute()` | `FrameGraph.execute()`         | Optional direct task-level execution hook. When present, the frame graph calls it instead of draining `_passes`.                                       |
| `dispose()` | `FrameGraph.dispose()`         | Release task-owned GPU resources; pass-backed tasks also dispose their owned passes.                                                                   |

`RenderTask` is the primary scene-render implementation of `Task`, and `EffectRenderTask` uses the same task/pass contract for fullscreen RTT effects. The interface exists so future frame-graph work can add other ordered task types without changing `FrameGraph` itself, for example compute tasks, copy/resolve tasks, object-list tasks, or resource-transition/helper tasks.

The `_passes` list is the per-task view of recorded passes. `FrameGraph.build()` clears it at the start of each task's record and the task is responsible for re-pushing its passes during `record()`. `RenderTask` is a direct task: `_passes` remains empty, `record()` prepares its descriptor/bindings, and `execute()` opens and closes the GPU render pass itself. User-defined pass-backed tasks and helpers created through `addRenderPass()` still use `_passes` plus the phase-2 `_initialize()` walk.

`FrameGraph.execute()` sums the draw count returned by `task.execute()` when present; otherwise it drains the recorded passes. Direct execution is the deliberate built-in fast path, not only a migration escape hatch. Per-task GPU timing is opt-in: the public timing API dynamic-imports a profiler that wraps registered `FrameGraph.execute()` functions at runtime, so non-profiling bundles do not fetch profiler code or carry a static task-timing branch here. The built-in `ShadowTask` uses this path for shadow scheduling: ESM generators expose depth/blur resources that `ShadowTask` encodes, while PCF generators are rendered through ShadowTask-owned depth-only `RenderTask`s that use Standard/PBR/Node no-color shadow material views. These PCF variants keep a void fragment stage when needed so material `discard` logic still affects the depth attachment without binding a color target.

`Task.executionEnabled` is a runtime-only gate that defaults to enabled. When set to `false`, `FrameGraph.execute()` skips both the task-level `execute()` hook and every recorded pass while preserving the task's recorded state and allocated resources. Task-specific fields such as `enabled` retain their own semantics and are not interpreted as this scheduling gate.

## `Pass` and `RenderPass`

A `Pass` is a unit of GPU work owned by exactly one pass-backed task. When a task has no direct `execute()`, `FrameGraph.execute()` drains its passes by calling `pass._execute()`. The split mirrors Babylon.js' `IFrameGraphPass` / `FrameGraphRenderPass`, with two intentional Lite-flavoured differences described below.

### `Pass` base interface

```typescript
export interface Pass {
    readonly name: string;
    _parentTask: Task;
    _dependencies: Set<RenderTarget>;
    _executeFunc: ((pass: GPURenderPassEncoder) => number) | null;
    _beforeExecute: (() => void) | null;
    _initialize(): void;
    _execute(): number;
    _dispose(): void;
}
```

| Method          | Called by                        | Purpose                                                                                                                                                                            |
| --------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_initialize()` | `FrameGraph.build()` (phase 2)   | Build any caches that need other tasks' RTs to already be allocated. `RenderPass` builds its `GPURenderPassDescriptor` here. May be a no-op for passes that don't need this stage. |
| `_execute()`    | `FrameGraph.execute()` per frame | Performs the concrete pass GPU work. Returns the number of draw calls issued (summed into the engine's draw counter).                                                              |
| `_dispose()`    | The owning task's `dispose()`    | Free pass-owned GPU/CPU state. Idempotent.                                                                                                                                         |

`addPassDependencies(pass, deps)` adds one or more `RenderTarget`s to `pass._dependencies` (`Set` semantics, idempotent). Lifted onto the base `Pass` (BJS keeps it on `FrameGraphRenderPass`) because it is a texture-graph-wide concept that future compute / copy / object-list passes will want without re-introducing per pass type. Today it is informational only; the upcoming texture-virtualization step will read it to compute lifetimes / aliasing.

### `RenderPass`

```typescript
export interface RenderPass extends Pass {
    _renderTarget: RenderTarget | null;
    _renderTargetDepth: RenderTarget | null;
    _renderPassDescriptor: GPURenderPassDescriptor;
    _colorAttachment: GPURenderPassColorAttachment | null;
    _depthAttachment: GPURenderPassDepthStencilAttachment | null;
    clearColor: GPUColorDict;
    clear: boolean;
}
```

A `RenderPass` brackets a single `encoder.beginRenderPass(...)` / `pass.end()` and delegates the body to the base `Pass._executeFunc`. The cached descriptor is built once in `_initialize()` (phase 2 of `FrameGraph.build()`) from `_renderTarget` / `_renderTargetDepth`. Per-frame, `_execute()`:

1. Runs `_beforeExecute`, if present.
2. Patches the cached color attachment with live `clearColor`, `clear`, and the target's current `_colorView`.
3. `enc = engine._currentEncoder.beginRenderPass(_renderPassDescriptor)`.
4. `draws = _executeFunc?.(enc) ?? 0`.
5. `enc.end()` and returns `draws`.

`_renderTargetDepth` is optional. When `null`, the depth view comes from `_renderTarget` (today's combined-RT behavior, matching BJS' default).

### Pass actions

User task code creates and configures passes through public actions:

| Function                          | Purpose                                                                                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addRenderPass(target, name)`     | Create a `RenderPass`, associate it with the currently-recording task (via `FrameGraph._currentProcessedTask`), push it onto `task._passes`, return it. Must be called from inside `Task.record()`. |
| `addPassDependencies(pass, deps)` | Add one or more `RenderTarget`s the pass reads from (idempotent).                                                                                                                                   |

Lower-level `setRenderPass*` helpers live beside the state they mutate: render-target / clear-state setters live in `frame-graph/render-pass.ts`, while generic pass callbacks (`setRenderPassExecuteFunc`, `setRenderPassBeforeExecute`) live in `frame-graph/pass.ts`. `setRenderPassClear(pass, clear, clearColor)` updates the clear/load flag and clear color together without allocating a state object. These helpers are intentionally **not** re-exported from the package today. Pass-backed helpers use `createRenderPass(...)`, which atomically creates the pass and appends it to `task._passes`, then configure it through the setters. Direct built-in tasks such as `RenderTask` retain none of this pass-object orchestration.

### Two intentional Lite-flavoured differences from BJS

- **No shared `FrameGraphRenderContext`.** BJS routes the live render-pass encoder through a context object that's swapped between passes. In Lite, each `RenderPass` owns its descriptor and its base pass `_executeFunc(enc)` receives the live encoder directly. This keeps the surface flatter and avoids a per-pass indirection that costs bundle bytes for no gain at the current scale.
- **No numeric `TextureHandle` indirection.** `pass._renderTarget` / `pass._renderTargetDepth` are concrete `RenderTarget` references, not handles into a texture manager. The full virtualization story (handles, lifetime/aliasing analysis, deferred allocation, MRT, history textures) is a deliberate future step. The handle layer will be a typed-parameter change at known call sites (`setRenderPassRenderTarget`, `setRenderPassRenderTargetDepth`, and `_initialize()`); the rest of the surface is shaped to absorb it without churn.

Tasks execute in array order. There is no automatic dependency analysis; caller order is the contract.

```typescript
addTask(sceneOrGraph, task); // append at end
addTaskAtStart(sceneOrGraph, task); // insert at start of user work, after built-in system tasks such as ShadowTask
addTaskBefore(sceneOrGraph, task, beforeTask);
addTaskAfter(sceneOrGraph, task, afterTask); // insert immediately after afterTask
```

Rules:

- Offscreen producer tasks must run before consumers that sample their output.
- Overlay tasks should use `sharedRt: true`, `clr: false`, and run after the owning task. Add `depthClear: false` when they must depth-test against its rt-owned depth.
- `addTaskBefore()` appends if the `beforeTask` is not found.
- `addTaskAfter()` inserts immediately after `afterTask`, and appends if it is not found.
- If tasks are added or inserted outside the startup/resize path, caller code must rebuild the graph before the next frame.
- If a task uses `addMeshToTask()` before `registerScene()`, defer the explicit `build()` call until after `registerScene()` so deferred material builders have run.

### Internal Shadow Adapter Task

`registerSceneWithShadowSupport(scene)` installs an internal `ShadowTask` before the default `"scene"` render task:

```typescript
await registerSceneWithShadowSupport(scene);
createRenderTask({ name: "scene", rt: swapRT, clrColor: scene.clearColor }, engine, scene);
```

The task owns the caster-mesh inputs registered for each shadow generator. It records no direct passes of its own. During `record()`, it creates/records internal shadow render tasks so caster meshes are rendered through material-owned pipelines:

```typescript
record(): void {
    task._passes.length = 0;
    // PCF/ESM shadow generators record internal caster RenderTasks here.
}
```

Per frame, `execute()` iterates the scene's lights, renders each light's shadow generator from task-owned caster inputs, and returns the summed draw count. ESM adds blur passes after its internal material-view caster task; PCF executes the internal depth-only material-view task recorded earlier.

## Render Targets

### Descriptor

```typescript
export interface RenderTargetDescriptor {
    lbl?: string;
    format?: GPUTextureFormat;
    dFormat?: GPUTextureFormat;
    _depthClearValue?: number;
    _depthCompare?: GPUCompareFunction;
    samples: number;
    size: SurfaceContext | { width: number; height: number };
}
```

Render targets are pure-state descriptors plus owned GPU texture handles. `buildRenderTarget(rt, engine)` allocates textures during `RenderTask.record()`.

| Field              | Meaning                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lbl`              | Optional GPU debug label.                                                                                                                                         |
| `format`           | Optional color format. Omit for a depth-only target.                                                                                                              |
| `dFormat`          | Optional depth/stencil format. Omit for a color-only target such as the surface swapchain wrapper.                                                                |
| `_depthClearValue` | Internal clear depth; reverse-Z targets default to `0`, while standard-Z shadow targets use `1`.                                                                  |
| `_depthCompare`    | Internal pipeline depth compare; defaults to reverse-Z `"greater-equal"` when omitted by pipeline builders.                                                       |
| `samples`          | Attachment sample count (`1` or `4`).                                                                                                                             |
| `size`             | A `SurfaceContext` for live surface dimensions, or fixed `{ width, height }` device pixels. Passing `EngineContext` is valid because it extends `SurfaceContext`. |

The surface owns `scRT`, an eager single-sample color-only wrapper around the current swapchain
texture. A single-sample default `RenderTask` writes directly to `scRT` and owns a separate depth
target. With MSAA, the task writes to an owned multisample color/depth target and uses
`RenderTaskConfig.rst = surface.scRT` as the explicit single-sample resolve target. There is no
`resolveToSwapchain` descriptor flag.

### Target Signature

```typescript
export interface RenderTargetSignature {
    readonly _colorFormat?: GPUTextureFormat;
    readonly _depthStencilFormat?: GPUTextureFormat;
    readonly _depthCompare?: GPUCompareFunction;
    readonly _sampleCount: number;
    readonly _transmissionTexture?: Texture2D | null;
    _collectBatches?: (state: DrawBatchState | undefined, binding: DrawBinding) => DrawBatchState | undefined;
}
```

Material pipelines are cached by target signature. The attachment-key serializer lives in
`engine/render-target-signature.ts`, separate from allocation/disposal in `render-target.ts`, so
attachment-only consumers do not retain key construction. `_transmissionTexture` is installed only
for scene-color transmission, and `_collectBatches` is installed only by binding-update features.
All color targets render upright with the same projection and counter-clockwise front-face
convention; no descriptor or signature flip flag exists.

### Eager RTT Texture

```typescript
export interface RenderTargetTextureResult {
    readonly rt: RenderTarget;
    readonly texture: Texture2D;
    readonly depthTexture: Texture2D | null;
}

export type RenderTargetDepthSampler = (engine: EngineContext, target: RenderTarget) => Texture2D;
export function withSampledDepthTexture(engine: EngineContext, target: RenderTarget): Texture2D;
export function createRenderTargetTexture(engine: EngineContext, descriptor: RenderTargetDescriptor, sampleDepth?: RenderTargetDepthSampler): RenderTargetTextureResult;
export function createSurfaceRenderTargetTexture(
    engine: EngineContext,
    descriptor: RenderTargetDescriptor & { size: SurfaceContext },
    sampleDepth?: RenderTargetDepthSampler
): RenderTargetTextureResult;
export function disposeRenderTargetTexture(result: RenderTargetTextureResult): void;
export function onRenderTargetTextureResize(result: RenderTargetTextureResult, callback: () => void): () => void;
```

Use this when a pass output must be wired into a material before the frame graph is built. It eagerly allocates the render target and exposes the color attachment as `texture`. On a color target, a `dFormat` creates an owned depth-test attachment but no sampled depth facade by default. Pass `withSampledDepthTexture` as the third argument to opt into the additional `depthTexture`. A depth-only fixed or surface target must pass the helper; its `texture` and `depthTexture` then alias one sampled-depth wrapper.

```typescript
const output = createSurfaceRenderTargetTexture(engine, { format: engine.format, dFormat: "depth32float", samples: 1, size: engine }, withSampledDepthTexture);
```

**Breaking migration:** depth-only `createRenderTargetTexture(engine, descriptor)` calls that previously received sampled depth as the primary `texture` must now pass `withSampledDepthTexture` as the third argument. The same requirement applies to `createSurfaceRenderTargetTexture`. Missing helpers are rejected before attachment allocation. Color targets, including color targets with a depth-test attachment, do not retain the depth helper or sampled-depth facade unless explicitly requested. Requesting sampled depth without a depth attachment throws and releases partially constructed attachments.

The sampled-depth helper requires the actual depth allocation to be single-sampled. MSAA depth
cannot be exposed as `texture_depth_2d`; requesting the helper for multisampled depth throws
before creating a sampling view or sampler, and both RTT factories release the failed allocation.
Use a separate single-sample depth target for sampling. Unsampled depth-test attachments may
remain multisampled.
Surface resizing also rejects attachment sample-count changes before publication, retaining the
previous facade generation and releasing the failed replacement.

Every attachment has one render-target ownership reference in addition to references held by sampled
consumers. Removing the last sampler cannot destroy a live writer's attachment. The owning render task
releases the target references on disposal; remaining sampled consumers keep the last image alive.
Targets not handed to an owning task can be released with `disposeRenderTargetTexture`.
Disposal is idempotent and prevents subsequent rebuilding. `sharedRt` tasks and eager external
`depth` attachments are borrowers, not additional owners.

Eager allocation and disposal ownership are distinct: sampled targets install an attachment-release
hook, while engine swapchain and geometry/shadow wrappers retain their existing external owners.
Resize prepares replacement attachments before publishing them, transfers both writer and sampled
references, and retains the old allocation until resize consumers have rebuilt their bindings.
Only then is the old allocation retired after submitted GPU work drains.

Surface-sized RTT-derived `cloneTexture2D` wrappers share an attachment backing record with their source,
including clones of clones. Replacing its allocation generation updates texture, view, width,
and height for every wrapper atomically. UV transforms and sampler choices remain wrapper-local.
Ordinary texture clones retain snapshot semantics. Clone creation does not acquire a reference:
each sampled owner must still pair `acquireTexture` and `releaseTexture`. Cached bind groups
still require the existing resize callback to rebuild their captured views.

`createRenderTargetTexture` is the fixed-size factory. It retains attachment ownership and disposal
guards, but imports neither resize support nor replaceable clone backing. Surface-sized descriptors
require the separate `createSurfaceRenderTargetTexture` import; passing one to the fixed factory is
an explicit error, not a silently frozen target.

The surface factory lives in `texture/rtt-surface.ts`. Its target reallocates during a frame-graph
rebuild when dimensions or owning `GPUDevice` change, updates shared facades, and retires the old
allocation. Register `onRenderTargetTextureResize(result, callback)` when consumers cache bind groups;
the callback runs after facade replacement so callers can rebuild before the resized frame draws.

Resize delivery is synchronous and retryable. Each subscription has an independent pending flag:

- Publishing a replacement marks all current subscriptions pending and attempts every one, even when another throws.
- Successful subscriptions are acknowledged and are not repeated on an unchanged-size rebuild. Failed subscriptions retry on the next `buildRenderTarget` or frame-graph build even when dimensions and device already match.
- One failure is rethrown unchanged; multiple failures produce an `AggregateError` containing every thrown value. Callback failures never silently report success.
- Replaced color and depth allocations stay owned while delivery is pending. A later resize notifies all subscribers of the newest facade generation and keeps all older allocations alive until delivery succeeds. Releases then pass through the GPU retirement fence.
- Unregistration cancels that subscription's retry and immediately settles delivery bookkeeping. When no pending observers remain, held generations enter GPU-fenced retirement without another target build or target disposal. Unregistration never invokes another observer; a consumer canceling a pending retry must stop using its superseded views.
- If cancellation occurs inside a running callback, settlement waits until the current delivery pass returns. Duplicate subscriptions of the same function remain independent. Registrations added during delivery begin observing subsequent resizes.
- Disposing the target cancels delivery and fences all held replacements, including when releasing the current attachments throws.
- An unchanged-size nested target build does not recursively deliver callbacks. A callback attempting another physical resize receives an explicit error and can be retried by a later outer build.

The subscription registry, pending deliveries, and held-replacement list are owned entirely by
the surface RTT extension. Fixed-size targets and consumers that do not import surface RTT support
retain none of the callback-delivery machinery.

Completed retirement batches start the engine's microtask-delayed GPU fence immediately, so an
inactive target does not need another frame/build to release obsolete allocations. The microtask
still runs after the current synchronous frame submission when cancellation occurs inside a frame.

Callers of the branch's earlier automatic surface-size support must switch to this factory when
restacking. Fixed targets keep snapshot clone semantics and never retain the surface implementation.
Calls that used the branch's earlier implicit additional depth facade on a color target must pass
`withSampledDepthTexture`; ordinary depth-tested color targets need no sampling helper. Depth-only
calls must also pass the helper and migrate as described above.

Constraints:

- The target must own a color texture, or explicitly request sampled depth from a depth attachment; a borrowed swapchain view is not an RTT attachment.
- Fixed-size targets are marked eager and never reallocate. Surface-sized targets rebuild only when their backing-store dimensions change.

## `RenderTask`

Pipeline signature keys live in `engine/render-target-signature.ts`, separate from attachment
allocation and disposal in `engine/render-target.ts`. Material and effect builders import the key
function directly, so attachment-only consumers do not retain pipeline cache-key construction.

Target disposal snapshots and detaches both attachments before releasing either allocation.
Sampled targets receive those captured handles through their ownership hook; ordinary targets
destroy them directly. Reentrant disposal therefore observes an empty target, while a failing color
release still attempts depth cleanup. Sampled facades can keep independently acquired references
to the detached allocations.

The target also owns its disposed-state marker. Fixed RTTs install shared release/readiness
callbacks on that owner rather than closures retaining the result facade; surface resize
wrappers preserve the target receiver when forwarding attachment release.

`RenderTask` is the primary concrete frame-graph task and uses direct `Task.execute()`. During
`record()` it allocates targets, stages bucketed bindings, refreshes the task-owned scene bind group,
and builds its cached `GPURenderPassDescriptor`; `_passes` remains empty. Per frame, `execute()` runs
UBO/light/binding updates, patches live clear/resolve views, opens the render pass, draws, and ends it.

```typescript
export interface RenderTaskConfig {
    name: string;
    rt: RenderTarget;
    rst?: RenderTarget;
    depth?: RenderTarget;
    clrColor?: GPUColorDict;
    clr?: boolean;
    depthClear?: boolean;
    sharedRt?: boolean;
    cam?: Camera | null;
    cs?: boolean;
    transmission?: { copyCount?: number; generateMipmaps?: boolean; mipLevelCount?: number; grabDepth?: boolean };
    autoMirror?: boolean;
}
```

| Field          | Meaning                                                                                                                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | Used for labels and diagnostics.                                                                                                                                                                                                                          |
| `rt`           | Concrete render target for this pass.                                                                                                                                                                                                                     |
| `rst`          | Optional single-sample resolve target used when `rt` is multisampled.                                                                                                                                                                                     |
| `depth`        | Optional separate depth target. Eager targets are borrowed; non-eager targets are task-managed.                                                                                                                                                           |
| `clrColor`     | Clear color. The object may be mutated between frames.                                                                                                                                                                                                    |
| `clr`          | Defaults to clear. Set `false` to use color `loadOp: "load"` for overlays or multi-scene composition.                                                                                                                                                     |
| `depthClear`   | Controls rt-owned depth independently. Defaults to clear; set `false` to load existing depth. Ignored for external `depth` targets, which retain their eager/task-managed ownership policy.                                                               |
| `sharedRt`     | Marks `rt`/`rst` as owned by another, earlier task. This task uses the live views without rebuilding or disposing them.                                                                                                                                   |
| `cam`          | Optional per-pass camera. Defaults to `scene.camera`.                                                                                                                                                                                                     |
| `cs`           | Canvas-sized aspect flag. When true, scene UBO aspect uses canvas dimensions instead of RTT dimensions. This is useful for RTTs that are later sampled as a material texture but should preserve canvas aspect.                                           |
| `transmission` | Optional scene-texture transmission settings. `copyCount: 0` refreshes before every transmissive draw; otherwise the default is one refresh. `generateMipmaps` defaults to `true`; set `false` to allocate only mip 0 and skip refraction mip generation. |
| `autoMirror`   | Set `false` for an explicit render list that remains empty until populated with `addMeshToTask()`.                                                                                                                                                        |

### Image Processing Task

```typescript
export type ImageProcessingSource = Texture2D | RenderTarget | (() => Texture2D | RenderTarget | null | undefined);

export interface ImageProcessingTaskConfig {
    name?: string;
    source: ImageProcessingSource;
}

export function createImageProcessingTask(config: ImageProcessingTaskConfig, engine: EngineContext, scene: SceneContext): Task;
```

`createImageProcessingTask()` is a reusable fullscreen post-process task. During `record()` it resolves `config.source` to a `Texture2D` or `RenderTarget`, reads the source `GPUTexture.sampleCount` (falling back to `1`), builds the matching bind-group layout, and creates a fullscreen triangle pipeline targeting the swapchain format. During `execute()` it writes `scene.imageProcessing.exposure`, `scene.imageProcessing.contrast`, and `scene.imageProcessing.toneMappingEnabled` into a 16-byte uniform buffer, clears the swapchain to `scene.clearColor`, samples the source, applies exposure / tone map / gamma / contrast, and draws one triangle to the current swapchain view.

The shader has two source variants:

- single-sample: `texture_2d<f32>` with `textureLoad(source, pixel, 0)`
- multisample: `texture_multisampled_2d<f32>` with `textureNumSamples(source)`; each sample is independently image-processed and the processed colors are averaged

The task owns only its pipeline, bind group, and uniform buffer. It does not own the source texture. On graph rebuild, `record()` disposes the prior uniform buffer and rebuilds from the latest source returned by the getter.

Transmission uses this task as its final swapchain pass. `enableSceneTransmission(scene, engine)` retargets render tasks to linear `rgba16float` offscreen output, then appends one `"transmission-image-processing"` task after the last render task if one is not already present. MSAA scenes feed the image-processing task directly from the MSAA color texture, so there is no extra final resolve texture or `*-transmission-scene` target.

Transmission refraction textures allocate only the mip levels reachable by the refraction shader's fixed `-4.0` LOD bias. For the current 1024x1024 refraction textures, this means 7 levels (`0..6`) instead of the full 11-level chain, and mip generation records only those allocated levels. Tasks that set `transmission.generateMipmaps = false` allocate only mip 0 and skip this generation step.

### SMAA Task

`createSmaaPostProcessTask()` implements spatial SMAA as three ordered fullscreen passes:

1. Luma edge detection reads the final color source with linear sampling and writes an `rgba8unorm` edge target.
2. Blending-weight reconstruction reads exact edge texels with nearest sampling, searches each edge run, and writes an `rgba8unorm` weight target.
3. Neighbourhood blending reads the original color and the weights, then writes the anti-aliased output.

The source must be a single-sample `RenderTarget`; resolve MSAA before recording the task. SMAA is a perceptual filter, so place it at the end of the frame-graph chain after tone mapping. Set `sourceIsSrgb` when the source uses an sRGB view so edge detection re-encodes samples before applying the luma threshold. The task exposes `outputTexture`, `edgesTexture`, and `weightsTexture`; the intermediate targets are useful for diagnostics and are owned and disposed by the task.

The public controls are `threshold`, `maxSearchSteps`, `diagonalDetection`, `minDiagonalRun`, `cornerDetection`, `dominantAxisBlend`, and `sourceIsSrgb`. After changing one, call `updateUniforms()` once the graph has been recorded. Search steps and the minimum diagonal run trade additional texture fetches for longer pattern reconstruction. The simplified diagonal path is disabled by default because it can double-process adjacent diagonal edge channels; enable it only for content dominated by genuine 45-degree structure and measure the result. Corner-pattern attenuation is also opt-in: it uses reference SMAA's 25% corner-rounding preset and adds four edge-texture reads per processed axis only while enabled.

This implementation does not ship the reference Area/Search lookup textures. It reconstructs coverage analytically and searches directly in the weight pass, keeping the runtime self-contained. Predication, stencil optimization, and temporal SMAA modes are not implemented; use TAA when temporal supersampling is required. Scene 187 provides a deterministic side-by-side stress scene and loads its parameter UI only with `?debug=1`.

### Scene-Texture Transmission

`enableSceneTransmission(scene, engine)` wraps each `RenderTask` instead of adding material-specific behavior to the renderer:

1. Before the task records, it retargets swapchain output to a linear offscreen `rgba16float` render target using `engine.msaaSamples`, creates one shared 1024x1024 transmission texture for that task, and stores it on `task._targetSignature._transmissionTexture`.
2. The original `RenderTask.record()` then binds renderables against that target signature. PBR transmissive renderables create their material bind groups at this point, capturing the shared transmission texture; there is no per-draw transmission bind-group mutation.
3. After `record()` has built the render target, transmission stores `rt._colorTexture` as the source. If the source is MSAA or has a different size than the transmission texture, it creates the fullscreen blit pipeline and bind group once for this graph build; otherwise execute can use `copyTextureToTexture()` directly.
4. During execute, the render task starts one pass for the opaque bundle and direct bucket, then iterates the single camera-sorted transparent list. Before a `_transmissive` binding, while `copyCount` allows, the pass is ended, the current offscreen color is copied/blitted into the shared transmission texture, optional mips are generated, and the task resumes with `loadOp: "load"`. Remaining transparent and transmissive bindings continue through the same loop.

This keeps the refraction texture and all bind groups stable between graph rebuilds. `copyCount: 0` refreshes before every transmissive draw; finite values stop refreshing after the cap and draw the rest of the sorted transparent/transmissive list against the last snapshot.

### Default Scene Pass

`createSceneContext(engine)` creates this task by default; `createSceneContext(engine, { defaultRenderTask: false })` skips it for scenes that provide their own final swapchain task:

```typescript
const msaa = surface.msaaSamples > 1;
const rt = msaa
    ? createRenderTarget({
          lbl: "scene-color",
          format: surface.format,
          dFormat: "depth24plus-stencil8",
          samples: surface.msaaSamples,
          size: surface,
      })
    : surface.scRT;
const depth = msaa ? undefined : createRenderTarget({ lbl: "scene-depth", dFormat: "depth24plus-stencil8", samples: 1, size: surface });

_createAutomaticRenderTask({ name: "scene", rt, rst: msaa ? surface.scRT : undefined, depth }, engine, scene);
```

This task starts in scene-mirroring mode unless `autoMirror: false`. `addMeshToTask` selects explicit population when its additions commit. If the scene renderable version changes because of mesh add/remove/material swap, a scene-mirroring task re-syncs and rebinds its draw lists. An intentionally empty non-mirroring list remains empty across recordings; internal callers supplying borrowed renderables select `autoMirror: false`.

`RenderTask.enabled` defaults to `true`. A disabled task exits before per-pass updates and does not load attachments, resolve MSAA, or issue draws.

### Explicit Task Population

A render task can be explicitly populated with:

```typescript
addMeshToTask(task, mesh);
addMeshToTask(task, mesh, { material: overrideMaterialOrView });
```

**Breaking API migration:** replace `task.addMesh(mesh, options)` with
`addMeshToTask(task, mesh, options)`, imported from `@babylonjs/lite`. The constructor and
synchronous queue/live-add behavior are unchanged. Scene-mirroring passes no longer retain
auxiliary mesh construction, ownership, or transaction code merely by importing `createRenderTask`.

`addMeshToTask()` accepts a source material or `MaterialView`. Rebuild resolution uses the completed
scene-local material group's `r` closure. An existing group without `r` is not ready: it must never
fall back to a builder-wide closure cached by another scene. Only builders explicitly marked
`_sceneIndependentRebuild` (standalone geometry-view factories) may use `_rebuildSingle` without a
scene group. Ordinary task population, refresh, and explicit material rebuilds share
`material/resolve-mesh-rebuild.ts`'s `resolveMeshRebuild(scene, builder)` resolver.
Passing a material view lets a pass reuse source material state with pass-specific render feature
bits, for example Standard/PBR/Node no-color shadow variants used by PCF shadow render tasks.

Adds made **before** the task's first `record()` are queued and drained at `record()` time. The queue
is allocated only when explicit population is enabled; `createRenderTask()` and idempotent removal
alone retain no queue. A **runtime** add (after `record()`, once the task has published its scene bind
group) resolves the mesh and re-buckets it into that task immediately, so it renders on the next
frame without a `frameGraph.build()` — a full rebuild would reallocate the shared scene UBO and every
task's render target mid-frame.

If a task has explicit renderables, it does **not** auto-mirror the scene.

The scene's automatic render task borrows renderables and uses the lightweight
`render-task-base.ts` path. It has no explicit mesh-population API and no static dependency on
auxiliary ownership or `render-task-transaction.ts`. Shared pass execution, target handling,
binding buckets, removal, and GPU retirement stay in that base path. Public `createRenderTask`
also uses this path. `addMeshToTask` installs one optional explicit-record seam and the queueing
strategy on first use, leaving the task's stable `record` function intact. Transmission and other
wrappers therefore compose regardless of whether population happens before or after they are
installed, while `createRenderTask`-only bundles retain no transaction code. Public removal and scene
removal use the same base list eviction. The base removal and disposal paths retire only renderables
carrying the owner-provided lifetime-disposer sink, so automatic borrowed renderables remain
untouched and an earlier captured `dispose` function observes ownership added later.
Target ownership is captured from `sharedRt` at creation and used consistently by recording and
disposal; later edits to the configuration cannot silently change which task owns the attachments.
The stable scene UBO is task-owned from creation. Its scene bind group and shared light-buffer
binding are resolved on first recording, through the same refresh path used when lights change.
Material bindings are built first because `Renderable.bind` does not consume group 0. Scene
bind-group refresh is the final fallible recording step: it creates the new bind group before
assigning task-owned `_lightsUBO` / `_sceneBG`, so failure preserves both the old root bindings and
the old draw generation. Pass dimensions and descriptors update only after that succeeds.

Public and refresh-enabled explicit tasks share `render-task-transaction.ts`. Each auxiliary
renderable has a task-owned lifetime disposer list. The material-family
`MeshRebuilder(scene, mesh, materialOverride?, resources?)` receives those lists explicitly through
`MeshRebuildResources`. When `resources` is present, builders register allocation releases in
`resources._lifetimeDisposers` before subsequent fallible work and never register them in the scene's
main mesh disposer map. Cached resources created during binding also use the lifetime list
when they belong to the renderable. Binding-generation work is represented by `DrawUpdateBatch`
and its feature-owned `DrawBatchState`; there is no second, unused callback-generation ledger.
Fallible producers release unpublished private allocations before throwing.
Calls without a resource owner preserve ordinary scene-owned construction. Rebuilder wrappers must
forward the owner unchanged. Main-scene material swaps therefore cannot release an explicit task's
UBOs or texture leases, and explicit tasks no longer rewrite scene disposer maps temporarily.
Auxiliary ownership is stored directly on each task-owned `Renderable`; its existing `mesh` and
`_lifetimeDisposers` fields provide membership and cleanup without a parallel ownership list.
`autoMirror` is a construction mode; the first successfully committed explicit addition switches the
task permanently to explicit mode, including after its last owned renderable is removed. Each
resolution attempt collects its exact new renderables separately, so
rollback releases only unpublished allocations while transferred renderables remain untouched.
Every material rebuilder returns a fresh renderable identity for its supplied lifetime sink;
shared pipeline and view caches do not share the renderable itself. Population therefore appends
each rebuilt entry directly instead of doing a quadratic identity scan over previously resolved meshes.

Pending additions and source renderables are staged in a typed `RenderTaskPopulation` that has no
task methods, gates, wrappers, descriptors, or context. Binding produces a separate
`RenderTaskBindingGeneration` containing the source list, opaque/direct/transparent buckets, bundle
cache, batch state, and version keys. It is an off-task staged value, not persistent nested state.
Binding fills that candidate directly, without a second tuple container. Its source-version
snapshot is captured before target preparation and material binding, so a callback that changes
the scene cannot falsely mark those new renderables as already synchronized.
Only a complete rebuild, scene-BG refresh, and descriptor/context update publishes its known draw
fields to the task with `Object.assign`. Scene bindings and update context remain task-owned because
they have independent lifetimes. There are no mirrored or nested authoritative copies.

Failed attempts release only the disposer sinks created by that population, preserve the previous
draw-field identities, and retain pending requests for retry. Wrapper and gate mutations target the
live task throughout and are never copied from a candidate. Mesh refresh stages exact replacements
only for a real rebuild and retires them after draw-field publication; asynchronous preparation
constructs the same typed population but never publishes it. CSM transfers prepare one population and
generation per source/destination, assign every task's staged draw fields before retiring prior batch
states, and retain all source batch states during rollback. Rebinding retained renderables replaces
only their binding batch state; cached renderable-lifetime resources survive. Removing a mesh or
disposing a task retires its owned callbacks after submitted GPU work drains. Scene-mirrored
renderables remain borrowed.
Geometry tasks use the same explicit lifetime sinks. A sink is staged before each geometry
rebuild and is attached to the renderable before binding; rollback releases every unpublished
sink, including one whose rebuild or bind failed. Published geometry batches retire behind
the queue fence. The task's mesh-removal hook immediately evicts and retires all matching
entries even while rendering is stopped. Shared geometry-view resources are reference-counted
only by their renderable owners; there is no implicit view lease or scene auxiliary registry.
The lightweight automatic path still publishes complete binding buckets rather than retaining
partially constructed draw lists after a binding failure. It does not acquire auxiliary ownership.
The explicit population enabler installs the renderable-retirement seam. Automatic rendering
only calls that optional seam during removal/disposal and does not retain lifetime-list handling
or the resource-generation snapshot helper for borrowed renderables.
Standard and PBR register UBO releases as each allocation completes, before bind-group creation.
Standard's optional UV UBO joins the same ownership list. A failed initial uniform upload destroys
its just-created buffer before propagating the error.
Task cleanup snapshots callback/destroyable batches through the engine retirement service.
Immediate rollback and fenced cleanup share its error-reporting runner; destroy methods retain
their receiver, and callbacks appended after retirement wait for a later batch.

Update-batch collection and lifetime handling belong to `render/draw-update-batches.ts`, activated
by the uniform-copy and compute-dispatch batch factories. They install `_collectBatches` on the
task's target signature. Ordinary tasks carry no update-batch arrays or batch-difference algorithms.
When a binding exposes update batches, the collector builds a task-local `DrawBatchState` containing
the deduplicated active batch references and reset, flush, selection, and release operations.
That state is immutable after collection: removal builds a new selection rather than mutating a
published state. Candidate rollback releases only batches absent from retained states; successful
commit retires only batches absent from the new live states. Multi-task transfers supply all live
states so a batch borrowed from a source is not destroyed if destination binding fails.
No state is created for bindings without update batches, and inactive features perform no batch
reset/flush work. The ordinary renderer invokes optional hooks without importing their implementation.

Transfers move the ownership entry together with its renderable. Destination binding is transactional
across the affected tasks; failure leaves the source ownership and draw lists intact. Batched CSM
transfers stage all moves and bind each destination once. Async shader preparation uses temporary
auxiliary renderables without consuming the task's pending requests. That preparation helper is
imported by the asynchronous shader opt-in, not attached to every render task. Automatic and
explicit recording share target, descriptor, and dimension preparation; the explicit transaction
updates the task-owned context only after binding and scene-BG refresh succeed.

An explicit task normally keeps the renderables resolved by `addMeshToTask()`. Applications that replace
mesh geometry or change mesh materials at runtime can opt a task into following the corresponding
scene-renderable rebuilds:

```typescript
const task = createRenderTask({ name: "dynamic", rt, autoMirror: false }, engine, scene);
enableRenderTaskMeshRefresh(task);
addMeshToTask(task, dynamicMesh);
```

`enableRenderTaskMeshRefresh()` must run before the task is recorded. It tracks only scene-owned
meshes added without a per-task material override. It builds one auxiliary single-mesh renderable
per tracked mesh through the registered material-family rebuild hook, so an explicit task never
inherits untracked siblings from a merged scene renderable. The task claims and owns those auxiliary
disposers, rebuilds them when `scene._renderableVersion` changes, and retires replaced resources and
binding-update batches after submitted GPU work drains. The enabler wraps only the selected task;
applications that do not import it retain the base render-task and material-renderable bundle
footprint.

Refresh is a build-then-commit transaction. All tracked replacements, their explicit lifetime
disposer sinks, and their draw bindings are prepared before publishing new draw fields. If any
rebuild or binding throws, temporary resources are cleaned up and the previous task lists, bindings,
ownership, and version remain unchanged for retry. Only a complete replacement retires the
previous generation. Scene-owned main disposer lists are untouched throughout task construction.
An unfinished scene-local material build raises a synchronous readiness error. The tracked or
pending addition remains queued for a later `record()` / refresh retry after that build completes;
it neither publishes partial bindings nor starts another asynchronous material build.
Pending material overrides participate in the same transaction, including overrides queued before
enabling refresh and live `addMeshToTask(task, mesh, { material })` calls. Failed attempts leave the pending queue
intact and clean up only newly created resources. Committed overrides remain task-owned until mesh
removal or task disposal; later binding attempts stage their feature-owned batch resources.

Renderable lifetime resources are separate from binding-generation batch resources. A successful
rebind of a retained override retires its previous binding generation and keeps only the new one.
A failed attempt destroys only candidate bindings and restores the prior generation. Renderable
construction and lazily cached renderable resources remain alive until that renderable is replaced
or removed; cached culling state uses the explicit lifetime-disposer sink.

### Buckets and Draw Execution

At record/re-sync time, `RenderTask` converts renderables into `DrawBinding`s by calling:

```typescript
const binding = renderable.bind(engine, targetSignature);
```

During `record()`, the task builds/refreshes its targets, stages bindings, refreshes the scene bind
group, and then publishes descriptor/dimension and draw-generation state:

```typescript
task._updateContext.targetWidth = rt._width;
task._updateContext.targetHeight = rt._height;
Object.assign(task, generation);
```

Bindings are partitioned into:

| Bucket      | Renderable flags                   | Execution                                                                   |
| ----------- | ---------------------------------- | --------------------------------------------------------------------------- |
| Opaque      | `!isTransparent && !_direct`       | Cached `GPURenderBundle`                                                    |
| Direct      | `_direct`                          | Direct draw after opaque                                                    |
| Transparent | `isTransparent \|\| _transmissive` | Direct draw after direct, camera-space-depth sorted back-to-front per frame |

Opaque and direct buckets currently sort by `renderable.order`. Transparent is sorted by camera-space depth from the active pass camera and must not be pipeline-sorted.

`DrawBinding.pipeline` is mandatory. The per-pass-encoder body owns `setPipeline()` and deduplicates consecutive bindings with the same pipeline before calling the binding's `draw()` closure.

`_lastVersion` is exclusively the scene renderable version captured before the active binding
generation is built. `prepareRenderTaskPass()` compares it with `scene._renderableVersion` for
auto-mirroring source synchronization, while `enableRenderTaskMeshRefresh()` uses the same snapshot
to detect changes affecting its tracked meshes. Neither the ordinary nor transmission draw body
overwrites it. Opaque bundle invalidation is separate: a new binding generation publishes a fresh
`_ob`, explicit invalidation clears `_ob`, and `_lastVis !== _vis` handles global
visibility/resource changes. Replacing only the task's group-0 lights buffer clears `_ob` so the next
bundle captures the new scene bind group, but leaves `_lastVersion` and all material bindings intact.
It therefore does not trigger a redundant automatic rebind or explicit mesh refresh.

Before opening the pass each frame, `RenderTask.execute()` runs pre-pass work outside the encoder:

1. Auto-resync the renderable list if the scene's `_renderableVersion` has changed.
2. Refresh the task's scene bind group if the scene-wide lights buffer was replaced. This clears only `_ob`; source/material bindings remain synchronized.
3. Write the per-task scene UBO, refresh the scene-wide lights UBO, set `_updateContext._camera`, and call `binding.update?.(_updateContext)` for opaque, direct, and transparent bindings. This refreshes dirty per-binding UBOs with the pass target dimensions while allowing opaque render bundles to stay cached.
4. Sort transparent bindings back-to-front from the active camera, after updates so renderables can refresh `_worldCenter` first.
5. Patch the task-owned color attachment with the live target view, optional resolve view, clear color, and clear/load operation.

`RenderTask.execute()` then calls `beginRenderPass(task._renderPassDescriptor)`, runs the opaque
bundle plus direct and transparent draw lists, and ends the pass. Its `_passes` array is not involved.

### On-Demand Overdraw Cost Probe

```typescript
export interface OverdrawCostMeasure {
    width: number;
    height: number;
    sampleCount: number;
    bindings: number;
    msAsIs: number;
    msVisibleOnly: number;
    overdrawMs: number;
    ratio: number;
    msFrontToBack: number;
    sortGainMs: number;
    repeats: number;
}

export function measureRenderTaskOverdrawCost(engine: EngineContext, task: RenderTask, options?: { repeats?: number }): Promise<OverdrawCostMeasure>;
```

`measureRenderTaskOverdrawCost()` is an explicit, diagnostic-only probe for a previously rendered task. It replays the task's current visible bindings into transient attachments matching the task's color, depth, sample count, viewport, and scene bind group. Each repeat records three timestamped passes: shipped order with fresh depth, the same bindings against the first pass's final depth, and opaque/direct bindings sorted front-to-back while preserving transparent order. The returned medians estimate the current hidden-fragment shading budget and the portion recoverable by a per-draw sort.

The probe requires the optional WebGPU `timestamp-query` feature, a color target with a real depth aspect, populated draw bindings, and a positive integer repeat count. It rejects overlay tasks configured with `depthClear: false` and tasks using eager external depth because their shipped pass loads pre-existing depth that a transient fresh-depth replay cannot reproduce. It does not refresh binding state and intentionally waits for GPU readback, so callers run it only after the task has rendered and never in a production frame loop. The module has no state or import-time side effects; the heavy diagnostic implementation is dynamic-imported only when the public function is called, so unused scenes retain no probe runtime code.

## Per-Pass Scene UBO

Each `RenderTask` owns:

- `_sceneUBO`
- `_sceneBG`
- `_lightsUBO`
- `_updateContext`
- `_suData` scratch
- `_sceneUboCacheKey` dirty-check cache

`writePassSceneUBO()` writes the canonical 352-byte `SceneUniforms` layout:

| Float offset | Field                            |
| -----------: | -------------------------------- |
|            0 | `viewProjection`                 |
|           16 | `view`                           |
|           32 | `vEyePosition`                   |
|           36 | `envRotationY`                   |
|           40 | spherical harmonics coefficients |
|           76 | `exposureLinear`                 |
|           77 | `contrast`                       |
|           78 | `lodGenerationScale`             |
|           80 | `vFogInfos`                      |
|           84 | `vFogColor`                      |

The writer bails before touching scratch/GPU when camera, fog, aspect, exposure, contrast, and environment texture identity are unchanged. Environment rotation is written by the opt-in environment contributor; `setEnvironmentRotation` explicitly invalidates the task-local cache before a dynamic update.

Offscreen and swapchain targets use the same upright projection and counter-clockwise front-face
convention. There is no target-signature or descriptor flip flag; downstream copy/post-process
sampling handles the texture-coordinate convention uniformly.

## Usage: Offscreen Pass Feeding a Material

Scene 110 demonstrates the core pattern:

```typescript
const { rt, texture } = createRenderTargetTexture(engine, {
    lbl: "r1",
    format: engine.format,
    dFormat: "depth24plus-stencil8",
    samples: 1,
    size: { width: 512, height: 512 },
});

const consumerMaterial = createStandardMaterial();
consumerMaterial.diffuseTexture = texture;

const rttCamera = createFreeCamera({ x: 0, y: 0, z: -3 }, { x: 0, y: 0, z: 0 });
const task = createRenderTask({ name: "r1", rt, cam: rttCamera, clrColor: { r: 0.1, g: 0.1, b: 0.3, a: 1 }, cs: true }, engine, scene);

addTaskAtStart(scene, task);
addMeshToTask(task, sourceMesh, { material: overrideMaterial });

await registerScene(scene);
await getFrameGraph(scene).build();
await startEngine(engine);
```

Why this works:

1. `createRenderTargetTexture()` eagerly creates the texture so `consumerMaterial` can capture it in its bind group.
2. `addTaskAtStart()` runs the RTT pass before the default scene pass.
3. `addMeshToTask()` renders only the selected mesh into the RTT.
4. The default scene pass later samples the produced texture.

## Scene Removal and Material Swaps

`removeMeshFromTask(task, mesh)` removes a mesh from a task's source renderables and bucketed bindings. Scene removal calls this for frame-graph render-pass tasks so removed meshes do not continue drawing.

Material swaps use the scene material-swap queue and each material builder's `_rebuildSingle` hook. Auto-mirrored `RenderTask`s notice `_renderableVersion` changes and rebind their draw lists.

## Resize and Rebuild

`resizeEngine(engine)` updates the canvas backing store and calls each registered rendering context's `_resize()` hook. For scenes, `_resize()` rebuilds the frame graph so canvas-sized render targets are reallocated at the new dimensions.

Fixed-size eager RTTs are not reallocated by graph rebuilds because their GPU texture handles may already be captured by material bind groups.

## Design Boundaries

- The frame graph is intentionally ordered, not dependency-solved. Callers must insert producers before consumers.
- A future node render graph, if implemented in Lite, would be a separate higher-level DAG that emits this ordered task list.
- `RenderTask` is the primary concrete scene-render task, and `EffectRenderTask` is the fullscreen-effect RTT task. New `Task` implementations are expected as frame-graph coverage expands.
- `RenderPass` is the only concrete pass today, used by pass-backed tasks. `RenderTask` executes directly and does not synthesize a pass object.
- Render targets are concrete objects. There is no virtual resource aliasing or automatic lifetime analysis yet. `Pass._dependencies` is recorded for the future texture manager but not yet read by anything in Lite.
- `pass._renderTarget` and `RenderTaskConfig.rt` intentionally take a `RenderTarget` directly rather than a numeric `TextureHandle`. Handles + virtualization arrive as a follow-on step; the pass surface will absorb them as a typed-parameter change at known call sites.
- `addMeshToTask()` relies on material family rebuild hooks and therefore requires the mesh/material family to be part of the scene build.
- Transparent bindings sort by camera distance only; they are not pipeline-batched.

## Babylon.js FrameGraph Mapping

| Babylon.js concept              | Babylon Lite                                               |
| ------------------------------- | ---------------------------------------------------------- |
| Frame graph                     | Ordered `FrameGraph._tasks`                                |
| Frame graph task                | `Task` (with `_passes: Pass[]`)                            |
| `IFrameGraphPass`               | `Pass`                                                     |
| `FrameGraphRenderPass`          | `RenderPass` (no shared render context)                    |
| `frameGraph.addRenderPass`      | `addRenderPass(target, name)`                              |
| `addDependencies`               | `addPassDependencies(pass, deps)` (lifted onto base)       |
| Render pass task                | `RenderTask`                                               |
| Texture/resource handle         | Concrete `RenderTarget` for now                            |
| Task record/build phase         | `Task.record()` via `FrameGraph.build()` (phase 1)         |
| Pass post-record initialization | `Pass._initialize()` via `FrameGraph.build()` (phase 2)    |
| Per-frame execute phase         | `Task.execute()` when present; otherwise iterate `_passes` |
| Built-in direct task work       | Optional `Task.execute()`                                  |
| Render target texture           | `createRenderTargetTexture()`                              |
| Pass-specific camera/scene UBO  | `RenderTaskConfig.cam` + task-owned `_sceneUBO`            |

## File Manifest

| File                                         | Purpose                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/frame-graph/task.ts`                    | Polymorphic task interface (now with `_passes: Pass[]`)                                       |
| `src/frame-graph/pass.ts`                    | `Pass` base interface, `addPassDependencies`                                                  |
| `src/frame-graph/render-pass.ts`             | `RenderPass` interface, `createRenderPass`, `setRenderPass*` setters                          |
| `src/frame-graph/frame-graph.ts`             | Ordered task list and two-phase build/execute/dispose lifecycle                               |
| `src/frame-graph/frame-graph-actions.ts`     | Public task-insertion + `addRenderPass` actions                                               |
| `src/frame-graph/render-task-base.ts`        | Direct RenderTask target preparation, scene UBO/bindings, draw buckets, descriptor, execution |
| `src/frame-graph/render-task.ts`             | Public task factory plus lazily installed explicit mesh population seam                       |
| `src/frame-graph/render-task-transaction.ts` | Typed off-task population/binding staging, rollback, and known-field publication              |
| `src/frame-graph/overdraw-probe-run.ts`      | Timestamp-query replay implementation loaded only by the public GPU timing diagnostics probe  |
| `src/frame-graph/image-processing-task.ts`   | Reusable fullscreen image-processing task for swapchain output                                |
| `src/frame-graph/shadow-task.ts`             | Internal adapter task that schedules existing shadow generators through `Task.execute()`      |
| `src/engine/render-target.ts`                | Render target/signature state plus attachment allocation and disposal                         |
| `src/engine/render-target-signature.ts`      | Pipeline-cache key serialization for a `RenderTargetSignature`                                |
| `src/texture/rtt.ts`                         | Eager render-target texture helper                                                            |
| `src/render/renderable.ts`                   | `Renderable`, `DrawBinding`, and `DrawUpdateContext` contracts consumed by render-pass tasks  |
| `src/render/lights-ubo.ts`                   | Compatibility facade for split scene-light, mesh-layout, and mesh-selection helpers           |
| `src/render/scene-lights-ubo.ts`             | Scene-owned light GPU state, upload refresh, and task-camera light-data writer                |
| `src/render/mesh-light-layout.ts`            | Mesh-light UBO fields and WGSL packed-index accessor                                          |
| `src/render/mesh-light-selection.ts`         | Per-mesh light filtering and packed index writes                                              |
