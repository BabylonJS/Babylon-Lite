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
- a task records one or more `Pass` instances during `record()`; only `RenderPass` exists today
- a task may optionally implement `execute()` for legacy or non-recorded GPU work while that work is migrated into recorded passes
- render targets are explicit objects, not virtual graph resources yet
- the default scene render is itself a `RenderTask`

This gives Babylon Lite enough structure for offscreen RTT passes, per-pass cameras, and per-pass material overrides while keeping scheduling explicit, data-oriented, and tree-shakable. If Lite ever gets a node render graph, that higher-level authoring layer may be a DAG, but the executable frame graph remains an ordered list of tasks.

## Public API Surface

```typescript
export type { FrameGraph } from "./frame-graph/frame-graph.js";
export type { Task } from "./frame-graph/task.js";
export { getFrameGraph } from "./scene/scene.js";
export { addRenderPass, addTask, addTaskAtStart, addTaskBefore } from "./frame-graph/frame-graph-actions.js";

export type { Pass } from "./frame-graph/pass.js";
export { addPassDependencies } from "./frame-graph/pass.js";
export type { RenderPass } from "./frame-graph/render-pass.js";
export type { RenderPassExecuteFunc } from "./frame-graph/pass.js";

export type { RenderTask, RenderTaskConfig } from "./frame-graph/render-task.js";
export { createRenderTask, removeMeshFromTask } from "./frame-graph/render-task.js";
export type { ImageProcessingSource, ImageProcessingTaskConfig } from "./frame-graph/image-processing-task.js";
export { createImageProcessingTask } from "./frame-graph/image-processing-task.js";

export type { RenderTarget, RenderTargetDescriptor } from "./engine/render-target.js";
export { createRenderTarget } from "./engine/render-target.js";
export { createRenderTargetTexture } from "./texture/rtt.js";
```

### `FrameGraph`

```typescript
export interface FrameGraph {
    _tasks: Task[];
    _engine: EngineContextInternal;
    _scene: SceneContextInternal;
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
    readonly engine: EngineContextInternal;
    readonly scene: SceneContextInternal;
    _passes: Pass[];
    record(): void;
    execute?(): number;
    dispose(): void;
}
```

Task lifecycle:

| Method      | Called by                      | Purpose                                                                                                                                                                                                |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `record()`  | `FrameGraph.build()` (phase 1) | Allocate/rebuild GPU resources, register `Pass` instances onto `_passes` (typically via `addRenderPass(fg, name)` and friends), and finalize anything that needs the final canvas / target size. Sync. |
| `execute()` | `FrameGraph.execute()`         | Optional task-level execution hook. If present, the frame graph calls it instead of draining `_passes`. Used only for adapter tasks while legacy GPU work is moved under frame-graph scheduling.        |
| `dispose()` | `FrameGraph.dispose()`         | Release task-owned GPU resources. Should call `_dispose()` on each owned pass.                                                                                                                         |

`RenderTask` is the primary scene-render implementation of `Task`, and `EffectRenderTask` uses the same task/pass contract for fullscreen RTT effects. The interface exists so future frame-graph work can add other ordered task types without changing `FrameGraph` itself, for example compute tasks, copy/resolve tasks, object-list tasks, or resource-transition/helper tasks.

The `_passes` list is the per-task view of recorded passes. `FrameGraph.build()` clears it at the start of each task's record and the task is responsible for re-pushing its passes during `record()`. Today every `RenderTask` records exactly one `RenderPass`; the surface is shaped to support multi-pass tasks (e.g. shadow cascades) later without changing the `Task` interface again.

`Task.execute()` is a migration escape hatch, not the final shape for new rendering work. `FrameGraph.execute()` sums the draw count returned by `task.execute()` when present; otherwise it drains the recorded passes. Per-task GPU timing is opt-in: the public timing API dynamic-imports a profiler that wraps registered `FrameGraph.execute()` functions at runtime, so non-profiling bundles do not fetch profiler code or carry a static task-timing branch here. The built-in `ShadowTask` uses this path for shadow scheduling: ESM generators expose depth/blur resources that `ShadowTask` encodes, while PCF generators are rendered through ShadowTask-owned depth-only `RenderTask`s that use Standard/PBR/Node no-color shadow material views. These PCF variants keep a void fragment stage when needed so material `discard` logic still affects the depth attachment without binding a color target.

## `Pass` and `RenderPass`

A `Pass` is a unit of GPU work owned by exactly one task. A `Task` records one or more passes during its `record()`, and the shared internal `_executeTask()` helper drains those passes by calling `pass._execute()`. The split mirrors Babylon.js' `IFrameGraphPass` / `FrameGraphRenderPass`, with two intentional Lite-flavoured differences described below.

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

| Method          | Called by                      | Purpose                                                                                                                                                                            |
| --------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_initialize()` | `FrameGraph.build()` (phase 2) | Build any caches that need other tasks' RTs to already be allocated. `RenderPass` builds its `GPURenderPassDescriptor` here. May be a no-op for passes that don't need this stage. |
| `_execute()`    | `_executeTask()` per frame     | Performs the concrete pass GPU work. Returns the number of draw calls issued (summed into the engine's draw counter).                                                              |
| `_dispose()`    | The owning task's `dispose()`  | Free pass-owned GPU/CPU state. Idempotent.                                                                                                                                         |

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
    _swapchain: boolean;
    _sampleCount: number;
}
```

A `RenderPass` brackets a single `encoder.beginRenderPass(...)` / `pass.end()` and delegates the body to the base `Pass._executeFunc`. The cached descriptor is built once in `_initialize()` (phase 2 of `FrameGraph.build()`) from `_renderTarget` / `_renderTargetDepth`. Per-frame, `_execute()`:

1. Patches the cached color attachment with the live `clearColor` and the live `clear` flag (`loadOp = clear ? "clear" : "load"`). Parent tasks mutate `clearColor` / `clear` on the pass before iterating to mirror live scene state.
2. In swapchain mode (`_renderTarget.descriptor.resolveToSwapchain === true`), patches the per-frame swap view into either `resolveTarget` (MSAA) or `view` (no MSAA).
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

Lower-level `setRenderPass*` helpers live beside the state they mutate: render-target / clear-state setters live in `frame-graph/render-pass.ts`, while generic pass callbacks (`setRenderPassExecuteFunc`, `setRenderPassBeforeExecute`) live in `frame-graph/pass.ts`. `setRenderPassClear(pass, clear, clearColor)` updates the clear/load flag and clear color together without allocating a state object. These helpers are intentionally **not** re-exported from the package today. Built-in tasks use `createRenderPass(...)`, which atomically creates the pass and appends it to `task._passes`, then configure it through the setters. That keeps the public action and helpers fully tree-shakable for scenes that only use built-in tasks. The setters become public the moment a user-defined task type needs them.

### Two intentional Lite-flavoured differences from BJS

- **No shared `FrameGraphRenderContext`.** BJS routes the live render-pass encoder through a context object that's swapped between passes. In Lite, each `RenderPass` owns its descriptor and its base pass `_executeFunc(enc)` receives the live encoder directly. This keeps the surface flatter and avoids a per-pass indirection that costs bundle bytes for no gain at the current scale.
- **No numeric `TextureHandle` indirection.** `pass._renderTarget` / `pass._renderTargetDepth` are concrete `RenderTarget` references, not handles into a texture manager. The full virtualization story (handles, lifetime/aliasing analysis, deferred allocation, MRT, history textures) is a deliberate future step. The handle layer will be a typed-parameter change at known call sites (`setRenderPassRenderTarget`, `setRenderPassRenderTargetDepth`, and `_initialize()`); the rest of the surface is shaped to absorb it without churn.

Tasks execute in array order. There is no automatic dependency analysis; caller order is the contract.

```typescript
addTask(sceneOrGraph, task); // append at end
addTaskAtStart(sceneOrGraph, task); // insert at start of user work, after built-in system tasks such as ShadowTask
addTaskBefore(sceneOrGraph, task, beforeTask);
```

Rules:

- Offscreen producer tasks must run before consumers that sample their output.
- Overlay tasks should use `clr: false` and run after the task they overlay.
- `addTaskBefore()` appends if the `beforeTask` is not found.
- If tasks are added or inserted outside the startup/resize path, caller code must rebuild the graph before the next frame.
- If a task uses `addMesh()` before `registerScene()`, defer the explicit `build()` call until after `registerScene()` so deferred material builders have run.

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
    label?: string;
    colorFormat: GPUTextureFormat;
    depthStencilFormat?: GPUTextureFormat;
    sampleCount: number;
    size: "canvas" | { width: number; height: number };
    resolveToSwapchain?: boolean;
}
```

Render targets are pure-state descriptors plus owned GPU texture handles. `buildRenderTarget(rt, engine)` allocates textures during `RenderTask.record()`.

| Field                | Meaning                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `colorFormat`        | Color attachment format; use `engine.format` for swapchain-compatible output.                                                   |
| `depthStencilFormat` | Optional depth/stencil attachment format. Most 3D passes use `"depth24plus-stencil8"`.                                          |
| `sampleCount`        | `1` or `4`, matching WebGPU limits. Pipelines key on this value.                                                                |
| `size`               | `"canvas"` follows canvas backing-store size; fixed `{ width, height }` is used for stable RTTs.                                |
| `resolveToSwapchain` | True for swapchain passes. With MSAA, the task uses an owned MSAA color texture and resolves into the per-frame swapchain view. |

### Target Signature

```typescript
export interface RenderTargetSignature {
    readonly _colorFormat?: GPUTextureFormat;
    readonly _depthStencilFormat?: GPUTextureFormat;
    readonly _depthCompare?: GPUCompareFunction;
    readonly _sampleCount: number;
    readonly _flipY?: boolean;
}
```

Material pipelines are cached by target signature. `_flipY` is derived at task creation from `desc.flipY ?? !resolveToSwapchain` — offscreen RTs render with a Y-flipped projection so their texture samples upright in later passes; swapchain RTs render upright directly. Pipeline builders flip `frontFace` (`"ccw"` → `"cw"`) when `_flipY` is set so back-face culling stays correct.

`RenderTargetDescriptor.flipY` is a public override. Most scenes leave it unset and get the right convention from `resolveToSwapchain`. Known cases that set it:

- **Shadow-map RTs** (`shadow-base.ts`): `flipY: false`. Shadow maps are sampled in light-space, not screen-space, so Y-flip would invert sampling.
- **Transmission retargeting** (`transmission.ts`): forces `flipY = false` on the linear-offscreen color target so the transmission blit/sample chain stays upright through MSAA + image-processing.
- **Pipelined post-process chains** with a directionally-Y-asymmetric pass (Scene 143's chromatic aberration): set `flipY: false` on the scene-source RT so the asymmetric shift is computed in screen-correct orientation rather than mirrored.

### Eager RTT Texture

```typescript
export function createRenderTargetTexture(engine: EngineContext, descriptor: RenderTargetDescriptor): { rt: RenderTarget; texture: Texture2D };
```

Use this when a pass output must be wired into a material before the frame graph is built. It eagerly allocates the render target and exposes the color attachment as a `Texture2D`.

Constraints:

- `descriptor.size` must be fixed, not `"canvas"`.
- The render target must own a color texture; `resolveToSwapchain: true` with `sampleCount: 1` is invalid.
- The target is marked eager, so later `buildRenderTarget()` calls do not reallocate and invalidate already-created bind groups.

## `RenderTask`

`RenderTask` is currently the primary concrete frame-graph task. During `record()` it allocates its `RenderTarget`, builds bucketed bindings, and registers exactly one `RenderPass`. Per-frame pre-pass work (UBO writes, light refresh, per-binding updates, and live `clearColor` / `clear` mirroring) is installed as a render-pass before-execute hook, so shared task execution only drains `_passes`.

```typescript
export interface RenderTaskConfig {
    name: string;
    rt: RenderTarget;
    clrColor?: GPUColorDict;
    clr?: boolean;
    cam?: Camera | null;
    cs?: boolean;
    transmission?: { copyCount?: number; generateMipmaps?: boolean };
}
```

| Field      | Meaning                                                                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | Used for labels and diagnostics.                                                                                                                                                                                |
| `rt`       | Concrete render target for this pass.                                                                                                                                                                           |
| `clrColor` | Clear color. The object may be mutated between frames.                                                                                                                                                          |
| `clr`      | Defaults to clear. Set `false` to use color/depth `loadOp: "load"` for overlays or multi-scene composition.                                                                                                     |
| `cam`      | Optional per-pass camera. Defaults to `scene.camera`.                                                                                                                                                           |
| `cs`       | Canvas-sized aspect flag. When true, scene UBO aspect uses canvas dimensions instead of RTT dimensions. This is useful for RTTs that are later sampled as a material texture but should preserve canvas aspect. |
| `transmission` | Optional scene-texture transmission settings. `copyCount: 0` refreshes before every transmissive draw; otherwise the default is one refresh. `generateMipmaps` defaults to `true`; set `false` to allocate only mip 0 and skip refraction mip generation. |

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
const swapRT = createRenderTarget({
    label: "scene-swapchain",
    colorFormat: engine.format,
    depthStencilFormat: "depth24plus-stencil8",
    sampleCount: engine.msaaSamples,
    size: "canvas",
    resolveToSwapchain: true,
});

createRenderTask({ name: "scene", rt: swapRT, clrColor: scene.clearColor }, engine, scene);
```

This task auto-mirrors `scene._renderables` when its own `_renderables` list is empty. If the scene renderable version changes because of mesh add/remove/material swap, the task re-syncs and rebinds its draw lists.

### Explicit Task Population

A render task can be explicitly populated with:

```typescript
task.addMesh(mesh);
task.addMesh(mesh, { material: overrideMaterialOrView });
```

`addMesh()` accepts a source material or `MaterialView` and resolves at `record()` time through the source material family's `_buildGroup._rebuildSingle` hook. The mesh's material family must already be registered with the scene so the builder has run. Passing a material view lets a pass reuse source material state with pass-specific render feature bits, for example Standard/PBR/Node no-color shadow variants used by PCF shadow render tasks.

If a task has explicit renderables, it does **not** auto-mirror the scene.

### Buckets and Draw Execution

At record/re-sync time, `RenderTask` converts renderables into `DrawBinding`s by calling:

```typescript
const binding = renderable.bind(engine, targetSignature);
```

During `record()`, the task also builds/refreshes its `RenderTarget`, stores an update context from the resolved dimensions, and registers its `RenderPass`. The task wires the pass's render target, before-execute preparation, and an `_executeFunc` closure that holds the per-pass-encoder body (set viewport / scissor, bind scene group 0, replay the cached opaque bundle, draw direct + transparent bindings):

```typescript
task._updateContext.targetWidth = rt._width;
task._updateContext.targetHeight = rt._height;

const pass = createRenderPass(task.name, task);
setRenderPassRenderTarget(pass, task._config.rt);
setRenderPassBeforeExecute(pass, () => prepareRenderTaskPass(task));
setRenderPassExecuteFunc(pass, (enc) => executePassBody(task, enc));
```

Bindings are partitioned into:

| Bucket      | Renderable flags             | Execution                                                |
| ----------- | ---------------------------- | -------------------------------------------------------- |
| Opaque      | `!isTransparent && !_direct` | Cached `GPURenderBundle`                                 |
| Direct      | `_direct`                    | Direct draw after opaque                                 |
| Transparent | `isTransparent || _transmissive` | Direct draw after direct, camera-space-depth sorted back-to-front per frame |

Opaque and direct buckets currently sort by `renderable.order`. Transparent is sorted by camera-space depth from the active pass camera and must not be pipeline-sorted.

`DrawBinding.pipeline` is mandatory. The per-pass-encoder body owns `setPipeline()` and deduplicates consecutive bindings with the same pipeline before calling the binding's `draw()` closure.

Before opening the pass each frame, the `RenderPass` before-execute hook installed by `RenderTask` runs pre-pass work outside the encoder:

1. Auto-resync the renderable list if the scene's `_renderableVersion` has changed.
2. Refresh the task's scene bind group (the scene-wide lights buffer can be resized after this task was first recorded).
3. Write the per-task scene UBO, refresh the scene-wide lights UBO, set `_updateContext._camera`, and call `binding.update?.(_updateContext)` for opaque, direct, and transparent bindings. This refreshes dirty per-binding UBOs with the pass target dimensions while allowing opaque render bundles to stay cached.
4. Sort transparent bindings back-to-front from the active camera, after updates so renderables can refresh `_worldCenter` first.
5. Mirror live `scene.clearColor` (auto-filled tasks) or `_config.clrColor` plus `_config.clr !== false` onto every owned pass — so the pass picks them up when patching its color attachment.

Then the task iterates `_passes` calling `_execute()`. Each `RenderPass._execute()` patches the swapchain view + clearColor + loadOp, calls `beginRenderPass`, runs `executePassBody(task, enc)` (the closure captured at record time), and ends the pass.

## Per-Pass Scene UBO

Each `RenderTask` owns:

- `_sceneUBO`
- `_sceneBG`
- `_suData` scratch
- `_su` dirty-check cache

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

The writer bails before touching scratch/GPU when camera, fog, aspect, environment rotation, exposure, and contrast are unchanged.

Offscreen targets use `targetSignature._flipY` and negate the projection row so downstream texture sampling is upright. Swapchain targets do not flip. See "Target Signature" above for the descriptor-side `flipY` override and the known overriding cases.

## Usage: Offscreen Pass Feeding a Material

Scene 110 demonstrates the core pattern:

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
const task = createRenderTask({ name: "r1", rt, cam: rttCamera, clrColor: { r: 0.1, g: 0.1, b: 0.3, a: 1 }, cs: true }, engine, scene);

addTaskAtStart(scene, task);
task.addMesh(sourceMesh, { material: overrideMaterial });

await registerScene(scene);
await getFrameGraph(scene).build();
await startEngine(engine);
```

Why this works:

1. `createRenderTargetTexture()` eagerly creates the texture so `consumerMaterial` can capture it in its bind group.
2. `addTaskAtStart()` runs the RTT pass before the default scene pass.
3. `addMesh()` renders only the selected mesh into the RTT.
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
- `RenderTask` is the primary concrete scene-render task, and `EffectRenderTask` is the fullscreen-effect RTT task. New `Task` implementations are expected as frame-graph coverage expands.
- `RenderPass` is the only concrete pass today; the `Pass` base interface is shaped so future compute / copy / object-list passes plug in without re-flowing the `Task` contract.
- Render targets are concrete objects. There is no virtual resource aliasing or automatic lifetime analysis yet. `Pass._dependencies` is recorded for the future texture manager but not yet read by anything in Lite.
- `pass._renderTarget` and `RenderTaskConfig.rt` intentionally take a `RenderTarget` directly rather than a numeric `TextureHandle`. Handles + virtualization arrive as a follow-on step; the pass surface will absorb them as a typed-parameter change at known call sites.
- `addMesh()` relies on material family rebuild hooks and therefore requires the mesh/material family to be part of the scene build.
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
| Per-frame execute phase         | `_executeTask()` → iterates `_passes` calling `_execute()` |
| Legacy/non-recorded task work   | Optional `Task.execute()`                                  |
| Render target texture           | `createRenderTargetTexture()`                              |
| Pass-specific camera/scene UBO  | `RenderTaskConfig.cam` + task-owned `_sceneUBO`            |

## File Manifest

| File                                     | Purpose                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/frame-graph/task.ts`                | Polymorphic task interface (now with `_passes: Pass[]`)                                      |
| `src/frame-graph/pass.ts`                | `Pass` base interface, `addPassDependencies`                                                 |
| `src/frame-graph/render-pass.ts`         | `RenderPass` interface, `createRenderPass`, `setRenderPass*` setters                         |
| `src/frame-graph/frame-graph.ts`         | Ordered task list and two-phase build/execute/dispose lifecycle                              |
| `src/frame-graph/frame-graph-actions.ts` | Public task-insertion + `addRenderPass` actions                                              |
| `src/frame-graph/render-task.ts`         | Render task, per-pass scene UBO, target binding, draw buckets, per-pass-encoder body         |
| `src/frame-graph/image-processing-task.ts` | Reusable fullscreen image-processing task for swapchain output                              |
| `src/frame-graph/shadow-task.ts`         | Internal adapter task that schedules existing shadow generators through `Task.execute()`      |
| `src/engine/render-target.ts`            | Render target descriptors, allocation, disposal, target signatures                           |
| `src/texture/rtt.ts`                     | Eager render-target texture helper                                                           |
| `src/render/renderable.ts`               | `Renderable`, `DrawBinding`, and `DrawUpdateContext` contracts consumed by render-pass tasks |
