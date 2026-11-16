# Module: Engine

> Package path: `packages/babylon-lite/src/engine/engine.ts`

## Purpose

The Engine module is the lowest layer of Babylon Lite. It acquires a WebGPU adapter and device, configures the swap chain on a render canvas, creates MSAA and depth/stencil render targets, and drives the per-frame render loop via `requestAnimationFrame`. All other modules depend on the Engine for GPU device access and frame orchestration.

The render canvas may be either a DOM `HTMLCanvasElement` (main thread) or an `OffscreenCanvas` (e.g. one transferred to a Web Worker via `transferControlToOffscreen()`). The engine runs unchanged in both cases — see _Offscreen / Worker Rendering_ below.

## Public API Surface

```typescript
/** A surface the engine can render into: a DOM canvas or an OffscreenCanvas. */
export type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Read-only public view of a registered rendering context. */
export interface RenderingContext {
    clearColor: GPUColorDict;
}

/** Return the surface's live rendering-context list in render order. */
export function getRenderingContexts(surface: SurfaceContext): readonly RenderingContext[];

/** Move a registered context to its final position in the surface's render order. */
export function moveRenderingContext(surface: SurfaceContext, context: RenderingContext, index: number): boolean;

/** Return the rendering context's stable family identifier. */
export function getRenderingContextKind(context: RenderingContext): string;

/** Top-level scene context. */
export interface SceneContext extends RenderingContext {
    /** Optional display name for tooling and diagnostics. */
    name?: string;
}

/** Create a scene that composites over a base scene on the same surface. */
export function createOverlayScene(baseScene: SceneContext): SceneContext;

/** A utility scene and the scene it composites onto. */
export interface UtilityLayer {
    readonly scene: SceneContext;
    readonly mainScene: SceneContext;
}
export interface UtilityLayerOptions {
    addDefaultLight?: boolean;
    lightIntensity?: number;
}
export function createUtilityLayer(mainScene: SceneContext, options?: UtilityLayerOptions): UtilityLayer;
export function registerUtilityLayer(utility: UtilityLayer): Promise<void>;
export function disposeUtilityLayer(utility: UtilityLayer): void;

/** Handle to the WebGPU engine — public API surface.
 *  GPU internals (device, context, format) are @internal — not user-facing. */
export interface EngineContext {
    readonly canvas: RenderCanvas;
    readonly msaaSamples: number; // 1 or 4
    readonly format: GPUTextureFormat;

    /** GPU draw calls executed by the latest `renderFrame` call, summed across its selected surfaces. */
    drawCallCount: number;

    /** Instrumented GPU interval for the last measured frame, in milliseconds. Includes every frame
     *  command plus the opening and closing marker dispatches. 0 before the first sample and while disabled. */
    gpuFrameTimeMs: number;
}

/** Whether GPU frame-time measurement is available on this engine's device (the adapter offered the
 *  WebGPU `timestamp-query` feature). When false, `setGpuTimingEnabled` is a no-op. */
export function isGpuTimingSupported(engine: EngineContext): boolean;
/** Enable or disable per-frame GPU timing (disabled by default). While on, `engine.gpuFrameTimeMs`
 *  reports the instrumented frame interval including marker dispatches. Opt-in and zero-cost when unused. */
export function setGpuTimingEnabled(engine: EngineContext, enabled: boolean): void;

export type RenderTaskGpuTimingStatus = "unsupported" | "disabled" | "pending" | "available" | "error";
export interface RenderTaskGpuTiming {
    readonly index: number;
    readonly name: string;
    /** Raw task interval; intervals can overlap and are not additive. */
    readonly durationMs: number;
}
export interface RenderTaskGpuTimings {
    readonly status: RenderTaskGpuTimingStatus;
    readonly supported: boolean;
    readonly enabled: boolean;
    readonly frameIndex: number;
    readonly tasks: readonly RenderTaskGpuTiming[];
    /** Envelope from the earliest measured task begin to the latest measured task end. */
    readonly totalDurationMs: number;
    readonly droppedTaskCount: number;
    readonly error?: string;
}
export function isRenderTaskGpuTimingSupported(engine: EngineContext): boolean;
export function getRenderTaskGpuTimings(engine: EngineContext): RenderTaskGpuTimings;
export function setRenderTaskGpuTimingEnabled(engine: EngineContext, enabled: boolean): Promise<RenderTaskGpuTimings>;

/** Start the render loop for all registered rendering contexts. Resolves after the first frame renders. */
export function startEngine(engine: EngineContext): Promise<void>;
/** Resolve after all GPU commands submitted before this call have completed. */
export function waitForGpuIdle(engine: EngineContext): Promise<void>;
export function waitForGpuResourceRetirements(engine: EngineContext): Promise<void>;
/** Stop the render loop. */
export function stopEngine(engine: EngineContext): void;
/** Resize render targets to match canvas layout size. No-op for an OffscreenCanvas. */
export function resizeEngine(engine: EngineContext): void;
/** Set the backing-store size directly in device pixels (used for OffscreenCanvas). */
export function setEngineSize(engine: EngineContext, widthPx: number, heightPx: number): void;
/** Release all engine-owned GPU resources (render targets, device). */
export function disposeEngine(engine: EngineContext): void;
/** Render all engine surfaces, or an explicit non-empty subset, through one encoder and submission. */
export function renderFrame(engine: EngineContext, delta: number, surfaces?: readonly [SurfaceContext, ...SurfaceContext[]]): void;

export interface EngineOptions extends SurfaceOptions {
    readonly device?: never;
    readonly requiredLimits?: Record<string, GPUSize64 | undefined>;
    readonly useHighPrecisionMatrix?: boolean;
    readonly useFloatingOrigin?: boolean;
}

export interface EngineDeviceOptions extends Omit<EngineOptions, "requiredLimits" | "device"> {
    device: DeviceContext;
    requiredLimits?: never;
    requiredFeatures?: never;
}

export interface EngineFeatureOptions extends EngineOptions {
    readonly requiredFeatures: readonly GPUFeatureName[];
}

export function createEngineWithFeatures(canvas: RenderCanvas, options: EngineFeatureOptions): Promise<EngineContext>;

/** Create the Babylon Lite engine. Acquires GPU adapter + device, configures swapchain. */
export async function createEngine(canvas: RenderCanvas, options?: EngineOptions): Promise<EngineContext>;
export function createEngine(canvas: RenderCanvas, options: EngineDeviceOptions): Promise<EngineContext>;
```

### Internal Types (not exported)

```typescript
/** @internal — GPU internals accessible only to renderable/loader code. */
interface EngineContextInternal extends EngineContext {
    readonly device: GPUDevice;
    readonly context: GPUCanvasContext;
    readonly format: GPUTextureFormat;
    readonly alphaMode: GPUCanvasAlphaMode;
    _renderingContexts: RenderingContext[];
    _currentEncoder: GPUCommandEncoder;
    _swapchainView: GPUTextureView;
    _currentDelta: number;
    _cbs: GPUCommandBuffer[];
}
```

## Internal Architecture

### Initialization Sequence (`createEngine`)

1. **Adapter request**: `navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })` — throws if WebGPU unavailable.
2. **Device request**: `createDevice` requests Lite's opportunistically supported float-filtering, texture-compression (including unaligned compressed dimensions), timestamp-query, and primitive-index features. `createEngineWithFeatures` installs an internal feature resolver that validates and adds explicit features such as `shader-f16`; bundles that never call it fold the resolver check away.
3. **Canvas context**: `canvas.getContext('webgpu')` — throws if context unavailable.
4. **Swap chain configure**: `context.configure({ device, format, alphaMode })` where `format = navigator.gpu.getPreferredCanvasFormat()` and `alphaMode = options?.alphaMode ?? "opaque"`.
5. **MSAA**: Defaults to `msaaSamples = 4`, or `1` when requested.
6. **Rendering contexts**: Initializes an empty `_renderingContexts` list. Scenes and other renderers register themselves with the engine.

### Preparing a Device

`createDevice()` performs steps 1-2 independently of a canvas. Import it from the
package root into a small bootstrap bundle to overlap GPU initialization with
downloading application code:

```typescript
const [device, app] = await Promise.all([createDevice(), import("./app.js")]);
const engine = await createEngine(canvas, { device });
await app.start(engine);
```

An engine created with `{ device }` skips acquisition; without it, `createEngine` calls
`createDevice` itself. Configure limits when creating the device; its adapter and optional
features are selected during acquisition. `EngineDeviceOptions` rejects conflicting
acquisition options, including explicit features. `engine.device` exposes the context but
never its native handle.

A device context backs exactly one engine, which owns it: `disposeEngine` destroys the
device, and passing the same context to a second engine throws. Ownership transfers only
after initialization succeeds. If initialization fails, the caller can dispose or retry
with a supplied context that remains unclaimed. A partially initialized canvas is not
automatically unconfigured, matching existing failure behavior.

Opt-in recovery requests a replacement with the context's original limits and updates
the context in place.
See [Device Context](device-context.md) for the full ownership and recovery specification.

### Rendering-Context Introspection

`getRenderingContexts(surface)` returns the surface's existing registry array as a readonly live view; it does not allocate a snapshot. Registration and unregistration are therefore visible through a previously returned reference, in render order, with no per-frame work. `getRenderingContextKind(context)` returns `"scene"`, `"frame-graph-context"`, `"effect-renderer"`, `"sprite-renderer"`, or `"text-renderer"` for the current built-in contexts. Its return type is intentionally the open `string` type, so adding a new context family is not a breaking API change. It throws a `TypeError` when passed a structural public object that is not a rendering context created by Lite. A utility layer registers an ordinary scene context with the default name `"UtilityLayer"`; tools can display `SceneContext.name` without treating utility layers as a separate rendering-context family.

### Render Order, Overlay Scenes, and Utility Layers

`moveRenderingContext(surface, context, index)` moves an already registered context to its final integer position `index` (clamped to the registry bounds) and returns `false` without changing anything for an unregistered context. Non-integer indices throw `RangeError` before the registry is changed. It locates the context by identity, removes it, and inserts it into the same live registry array at the clamped position; moving an already-correct context also returns `true`. Contexts render in list order. Its standalone `rendering-context-order.ts` module imports the surface and context types only, allowing the operation to tree-shake from applications that never use it.

Every ordinary `SceneContext` clears its target, so registering a second ordinary scene on a surface appends it to the registry and it clears whatever earlier contexts drew, even when its camera viewport covers only part of the surface (a clear load operation affects the whole attachment). Composition over another scene is explicit: create the second scene with `createOverlayScene(baseScene)`, which is how side-by-side viewports (for example scene73) share one surface. This is a breaking change from earlier releases, in which a scene registered after any other context guessed the last registered context as its base and loaded instead of clearing. That guess picked the wrong base when a text renderer or another non-scene context was registered last, so a later utility layer cleared the whole swapchain.

`createOverlayScene(baseScene)` creates an opt-in overlay scene on the base scene's surface with a transparent clear color and records the base as the overlay's internal `_overlayBase`. It has its own camera, lights, and depth buffer and does not follow the base camera; it is registered with the ordinary `registerScene`, in either order relative to its base, and every registration regroups the overlay immediately after its base. A utility layer is an overlay scene with utility defaults: `createUtilityLayer(mainScene, options?)` calls `createOverlayScene(mainScene)`, names the scene `"UtilityLayer"`, follows the main scene's camera, and optionally adds the default light. The surface supplies the engine, so callers of the previous `createUtilityLayer(engine, mainScene, options?)` signature must drop the engine argument. `registerScene` configures the overlay against the main scene rather than against whichever context was registered last. `registerUtilityLayer` uses `moveRenderingContext` to group the layer immediately after its main scene and existing sibling overlays, preserving their registration order and leaving unrelated contexts in their existing relative order. With `msaaSamples === 1` the overlay loads the swapchain; with MSAA it renders into the main task's current MSAA color attachment and resolves it again. The grouping therefore puts later contexts such as text renderers after the layers, so their pixels are not overwritten by an overlay resolve.

An overlay scene (including a utility layer) whose base scene is not registered on the surface (not yet registered, unregistered, or disposed) stays registered but skips its `_update` and `_record` work. When its base scene is registered again, scene registration moves it back before its associated overlays and groups those overlays after it. Explicitly moving contexts afterward can change this order, so callers using `moveRenderingContext` must preserve the overlay grouping.

Overlay scenes may themselves host overlay scenes or utility layers. Their groups remain contiguous in depth-first order, with sibling overlays in registration order. An overlay is active only while every scene in its base chain is registered. Because an overlay's base is fixed at creation, `createOverlayScene` wraps the overlay's record once, at creation; unregistering and re-registering the overlay adds no callbacks or wrappers.

Scene registration has one optional, module-level seam: `_installOverlaySceneRegistration(registered)` in `scene/scene-core.ts`. `createOverlayScene` installs it; `scene/overlay-scene.ts` owns the installed function, the inactive-base wrapper, descendant discovery, and explicit grouping. Apps that never import `createOverlayScene` tree-shake the installer, so the minifier removes the seam call entirely and single-scene or multi-surface apps carry no overlay code. Registration calls the installed function only after a new context is successfully inserted, including on the shadow-support registration path. The installed function resolves the topmost root of the overlay tree; while that root is unregistered nothing moves, so siblings registered meanwhile keep their registration order. Otherwise it moves the root before any earlier explicit descendant and recursively moves each direct child and its subtree after the root in their existing relative order. Once installed, the seam applies to every engine in the app; on a surface without overlays its grouping is a no-op. No sorting or registry search is added to the per-frame render loop.

The swapchain configurator (`scene/swapchain-overlay.ts`) reads the overlay's fixed `_overlayBase`; it never guesses a base from the context registry. It wraps the overlay's `_record`, so composition runs after every before-render callback and never competes with app callbacks that gate the task. Each record re-resolves the overlay's first swapchain-targeting render task, so a task added after creation or registration, or one that replaces the previous presentation task, is configured on its next frame; a replaced task gets back its original clear state and its own color view. Single-sample tasks disable color clearing, so the overlay loads the swapchain. MSAA tasks composite into the root scene of the overlay chain: while the root's presentation task is disabled, paused with `executionEnabled === false`, or does not resolve into the swapchain (post-process or copy output), the overlay task is disabled for that record only and its `enabled` value is restored afterward, so an app's `task.enabled` gate is never overwritten; otherwise the overlay shares the root's live attachment and loads and resolves it. The inactive-base wrapper wraps the composition wrapper and skips it while any scene in the base chain is unregistered, so an absent base's attachment is never referenced. The root task's attachment is re-read every frame, so a resized or rebuilt base attachment is picked up automatically.

#### Module: overlay scene

- **Purpose and API:** `createOverlayScene(baseScene)` is the public opt-in. `moveSwapchainOverlaysAfterBase` (internal) regroups a scene's overlay tree and is shared with `registerUtilityLayer`. `configureSwapchainOverlayScene(overlay)` (internal) configures composition.
- **State and lifecycle:** Each overlay stores only `_overlayBase` plus its record wrapper's closure (the configured task and its original clear state). No module-level state is allocated apart from the installed seam. Disposing an overlay releases its wrapper with the rest of the scene; disposing a base leaves its overlays registered but inactive.
- **Rendering:** Single-sample tasks load the swapchain. Multisample tasks use the base scene's current multisample color view, then resolve into the swapchain. Existing per-scene depth handling is unchanged; this module adds no shader or pipeline configuration.
- **Dependencies:** Scene and surface types, the scene-core seam, and the rendering-context move helper. The configurator is imported statically by `overlay-scene.ts` only.
- **Tests and files:** `tests/lite/unit/rendering-context-registration.test.ts`, `tests/lite/unit/swapchain-overlay.test.ts`, and `tests/lite/integration/utility-layer-overlay.spec.ts`; implementation `packages/babylon-lite/src/scene/overlay-scene.ts` and `swapchain-overlay.ts`.

`tests/lite/unit/swapchain-overlay.test.ts` and `rendering-context-registration.test.ts` cover the explicit base when text or later scenes are registered last, late MSAA attachments, app `enabled` gates set in before-render callbacks, paused base tasks, replaced presentation tasks, post-process bases (including through a nested overlay chain), overlay and utility ordering, sibling order when nested overlays register before their root, absent ancestors, re-registration, disposal, overlapping registration, and ordinary scenes that clear instead of compositing. `tests/lite/integration/utility-layer-overlay.spec.ts` checks actual WebGPU pixels for overlay scenes, nested utility layers, text composition, and a later ordinary scene clearing the surface at sample counts 1 and 4, including utility-first registration.

### Render Targets

The engine no longer owns per-frame color/depth render targets directly. Render targets are owned by registered rendering contexts, primarily scene frame-graph `RenderTask`s. The engine owns the canvas/swapchain and exposes the current swapchain view once per frame through `_swapchainView`.

Render-target disposal has one shared attachment-detachment path. Ordinary targets destroy their
owned textures; sampled RTTs install an owner callback that releases texture references instead.
Both paths clear attachment handles, views, and dimensions even if a release throws. Eager wrappers
without an owner callback remain borrowed and are not detached or destroyed.
The RTT factory selects color-versus-depth sampling from the requested format before allocating
the target. Allocation cannot change that choice, so a depth-only caller does not retain the
color-facade and bilinear-sampler path merely because GPU allocation receives the descriptor.

### Resize Logic

`resizeEngine(engine)` is called at the **start of every frame** (inside the rAF callback), not on a resize event. It auto-sizes only a **DOM canvas** from its layout box:

```
if canvas is not an HTMLCanvasElement: return         // OffscreenCanvas → externally sized
w = canvas.clientWidth * devicePixelRatio | 0
h = canvas.clientHeight * devicePixelRatio | 0
setEngineSize(engine, w, h)                           // applies only if changed
```

`setEngineSize(engine, w, h)` is the shared apply path:

```
if w<=0 or h<=0: return
if (w == canvas.width && h == canvas.height) return
canvas.width = w; canvas.height = h;
for each registered context: context._resize?.()
```

The bitwise OR with 0 (`| 0`) truncates to integer.

### Offscreen / Worker Rendering

An `OffscreenCanvas` has no layout box (`clientWidth`/`clientHeight`) and no attributes, so:

- The canvas tag (`setAttribute("data-engine", …)`) is skipped for it. That tag is applied in `_buildSurface`, guarded by a DOM-canvas check, so every DOM canvas Babylon Lite renders into — the engine's primary canvas and any auxiliary `createSurface` canvas — carries it.
- `resizeEngine` is a **no-op** for it — the visible canvas lives on another thread.
- The host thread (which owns the visible canvas) measures the CSS size, multiplies by `devicePixelRatio`, and posts those device-pixel dimensions to the worker, which calls `setEngineSize(engine, w, h)`. This both sets the backing store **and** fires `_resize()` hooks so canvas-sized GPU resources rebuild.

Everything else (adapter/device acquisition, `getContext("webgpu")`, the rAF render loop) is identical — dedicated workers in Chromium expose `requestAnimationFrame`/`cancelAnimationFrame`. See the **Offscreen** lab demo (`lab/lite/src/demos/offscreen*.ts`) for an end-to-end main-thread-vs-worker example.

### Render Loop

`startEngine(engine)` returns a `Promise<void>` that resolves after the first frame has been rendered. Any scene registered before the call participates in the first frame; later registrations join on subsequent frames.

`waitForGpuIdle(engine)` delegates to the WebGPU queue fence and resolves after all commands submitted before the call have completed. It does not wait for deferred resource-release callbacks. It is intended for infrequent lifecycle synchronization, not steady-state frame loops.

`waitForGpuResourceRetirements(engine)` is the separate orderly-teardown boundary. Stop producers and
dispose scene/render-task consumers first, then await this function before disposing their shared
resources. It yields past the current synchronous frame, snapshots outstanding retirement batches,
waits for submitted GPU work, and claims those exact batches synchronously. The ordinary deferred
fence may also claim a batch, but its callbacks run only once. Retirements queued during the wait or
by another release callback are drained in subsequent fenced batches. Newly queued batches are never
released against an earlier fence. GPU-fence failure rejects without releasing unfenced resources;
callback failures are reported while remaining callbacks are attempted. The drain is tree-shakable
and introduces no additional steady-frame scheduling.

Retirement users install the engine's optional `_flushGpuRetirements` seam on their first queued
release. Frame submission and stopping only invoke that seam; engine creation does not import the
retirement implementation. `disposeEngine` lives in a separate module so its synchronous drain does
not pull retirement code into the initial Vite chunk of applications that never queue a retirement.
Outstanding fenced batches are tracked by identity in a `Set`, preserving insertion order for
teardown while allowing either the fence callback or an explicit drain to remove a batch directly.
Each batch is claimed by emptying its callback array before running any callback.
The core queue and its batch helper accept cleanup callbacks only. Feature-specific collections
of callbacks and objects with `destroy()` use `gpu-resource-disposal.ts`, which is separate so
ordinary rendering does not retain heterogeneous-disposer dispatch.

```
registerScene(scene):
  adds scene as a RenderingContext

startEngine(engine):
  return new Promise(resolve => {
    renderFn = (now) => {
      resizeEngine(engine);
      deltaMs = now - prev
      renderFrame(engine, deltaMs);
      resolve()                  // first frame only
      prev = now
      animFrameId = requestAnimationFrame(renderFn);
    };
    animFrameId = requestAnimationFrame(renderFn);
  })

stopEngine(engine):
  cancelAnimationFrame(animFrameId);
  animFrameId = 0; renderFn = null;
```

Scenes read `engine._currentDelta` during their `_update()` step. If `scene.fixedDeltaMs` is set, the scene uses that value instead — useful for deterministic animation playback.

### Frame Rendering (`renderFrame`)

`renderFrame(engine, delta, surfaces?)` renders every surface in `engine.surfaces` in registration order when `surfaces` is omitted. The default list is live: if an earlier surface callback disposes a later surface, the remaining frame and capture loops observe the shorter list and skip the disposed surface. Passing a non-empty readonly tuple renders exactly that fixed subset in caller order through the same encoder and submission. Explicit tuple ownership is verified before encoder creation; callers must provide registered, unique surfaces and keep them registered until the call returns to avoid per-frame registration scans or deduplication allocations. Cache a singleton tuple when repeatedly rendering one surface to avoid caller-side per-frame allocation.

`engine.drawCallCount` records the calls emitted by the latest completed `renderFrame` invocation, summed across only its selected surfaces. Rendering callbacks continue to observe the previous completed frame's value; a successful no-context invocation publishes zero before returning.

Each invocation consists of:

1. **Preflight selected surfaces**: validate engine ownership and count their rendering contexts. If none exist, flush pending resource retirements and return without allocating or submitting an empty encoder.
2. **Create command encoder**: `device.createCommandEncoder({ label: "frame" })` and assign `engine._currentEncoder`.
3. **Prepare each selected surface**: run its optional screenshot pre-frame hook, then acquire the surface's current swapchain texture into `surface.scRT`.
4. **Update/record contexts**: For each selected surface, call `_update()` then `_record()` on every registered `RenderingContext`.
    - A scene `_update()` runs before-render callbacks, material swaps, shadow maps, legacy pre-passes, and shared uniform updaters.
    - A scene `_record()` delegates to `scene._frameGraph.execute()`.
    - A render task that targets `scene.surface.scRT` re-reads that surface's attachment view immediately before opening the pass. It must not compare against `engine.scRT`, which identifies only the primary canvas and would leave auxiliary scenes submitting an expired build-time swapchain view.
5. **Record screenshot copies**: each selected surface with queued requests copies its just-rendered swapchain texture into one staging buffer.
6. **Submit**: finish the command encoder and submit via the reusable `engine._cbs` array to avoid per-frame array allocation.

The per-surface attachment refresh is required because `GPUCanvasContext.getCurrentTexture()` returns a new swapchain texture over time. Reusing the auxiliary surface's view captured during frame-graph build produces a WebGPU validation error; because one command buffer contains every surface's work, that invalid auxiliary pass also discards the primary canvas's rendering.

Both all-surface and explicitly targeted frames use the same retirement seam and encoder lifetime.
The active encoder is cleared in `finally`, including when a selected surface throws; partially
recorded work is not submitted and the previous draw count remains published. A selection with no
rendering contexts still flushes pending retirements through the opt-in seam.

### Deferred Builder Execution

When `registerScene(scene)` is called, the scene runs its deferred builders, builds material renderables, and rebuilds its frame graph. `startEngine(engine)` then begins the rAF loop and resolves after the first `renderFrame()` call completes.

Swapchain MSAA/depth attachments are managed by the default scene `RenderTask` through render-target helpers, not by the engine render loop itself.

### GPU Frame Timing (optional, zero-cost when unused)

`setGpuTimingEnabled(engine, true)` publishes a lightly-smoothed **GPU** interval to
`engine.gpuFrameTimeMs` (milliseconds). The interval begins at the opening marker pass and ends at the
closing marker pass, so it includes every command recorded for the frame plus both one-workgroup marker
dispatches. It is distinct from CPU/wall-clock time and is an instrumented profiling value rather than a
marker-free sum of render/compute pass durations. The feature is a developer/HUD aid and is disabled by default.

The feature is implemented so that scenes which never enable it pay **zero** for it — the heavy timer code (`src/engine/gpu-timer.ts`) is reachable only through a dynamic `import()` inside `setGpuTimingEnabled`, which is itself tree-shaken away when unused. `renderFrame` carries three frame-timing optional-chain short-circuits plus the independent task-timing resolve short-circuit described below; all are no-ops while their profiler is off. The only other always-bundled cost is requesting the `timestamp-query` device feature opportunistically in `createEngine` (free at runtime) and a one-field initializer — a handful of bytes that remain within the existing scene bundle ceilings.

How it works when enabled:

1. `createEngine` opportunistically requests the `timestamp-query` feature whenever the adapter offers it (alongside the texture-compression features), so timing can be turned on later. `isGpuTimingSupported(engine)` reports whether it was available.
2. The first `setGpuTimingEnabled(engine, true)` dynamic-imports `gpu-timer.ts`, lazily creates a `GpuFrameTimer` (a 2-slot `timestamp` query set, one no-binding compute pipeline, and recycled MAP_READ readback buffers), and installs three per-frame hooks on the engine (`_gpuTimerBegin` / `_gpuTimerEnd` / `_gpuTimerResolve`).
3. Each frame marker records one compute workgroup with an empty shader body (`@compute @workgroup_size(1) fn main() {}`), using the pipeline allocated once with the timer. The opening pass writes query 0 at its beginning; the closing pass writes query 1 at its end. The pipeline stays with the timer across disable/re-enable, has no buffers or bindings, and requires no explicit destroy method. The two marker dispatches are part of the measured interval; their cost must be measured on the target device.
4. `renderFrame` records the opening marker into its command encoder after creating it and the closing marker before finishing it. After submission, `_gpuTimerResolve` records query resolution and a buffer copy, then maps asynchronously. Valid non-negative intervals under 5 seconds feed the existing exponential smoothing (80% previous value, 20% new value after the first positive sample). Positive timestamps alone do not establish freshness or cross-pass timing accuracy; target-device validation must check raw samples.

Disabling clears the frame begin/end hooks and resets `gpuFrameTimeMs` to 0; the shared resolve hook becomes a no-op unless task timing remains enabled independently. The frame timer's GPU resources are kept and reused if it is re-enabled.

#### Marker-overhead evidence and limits

The retained marker design was measured on Windows 10, Chrome 151, and an NVIDIA Blackwell adapter with
1,000 interleaved timestamp-query pairs after a warm-up submission:

- baseline: one no-op workgroup inside one compute pass with beginning/end timestamps;
- instrumented: an opening marker pass, the same payload pass, and a closing marker pass;
- baseline median / p95 / mean: `0.544 / 0.608 / 0.5392 µs`;
- instrumented median / p95 / mean: `0.544 / 0.576 / 0.4621 µs`.

The measured median delta was `0.000 µs`; the p95 and mean differences were smaller than timestamp noise
and must not be interpreted as negative overhead. On this target, the two marker passes therefore added no
measurable GPU interval, including for the deliberately minimal one-workgroup payload. This is evidence for
that adapter/driver only, not a universal guarantee: tile-based and other GPU architectures may expose a
different pass-boundary cost. Callers comparing sub-microsecond workloads across devices must account for
the documented markers, and exact task/pass attribution should use the separate task timing API.

### GPU Render-Task Timing (optional, zero-cost when unused)

`setRenderTaskGpuTimingEnabled(engine, true)` enables per-frame-graph-task GPU timings. It returns a snapshot immediately (`"pending"` after a successful enable), and `getRenderTaskGpuTimings(engine)` returns the latest asynchronously completed frame:

```typescript
await setRenderTaskGpuTimingEnabled(engine, true);
// Later, after one or more rendered frames:
const timings = getRenderTaskGpuTimings(engine);
if (timings.status === "available") {
    for (const task of timings.tasks) {
        // task.name is the existing Task.name label ("shadow", "scene", "post-process", ...)
        console.log(task.index, task.name, task.durationMs);
    }
}
```

Unsupported devices are explicit: if the WebGPU device lacks `timestamp-query`, `isRenderTaskGpuTimingSupported(engine)` is false and both enable/read APIs return `status: "unsupported"` with an empty `tasks` array.

Bundle-size protection mirrors screenshot capture and frame timing:

1. `createEngine` only requests `timestamp-query` opportunistically when the adapter offers it.
2. The public API lives in a thin module (`engine/gpu-task-timing.ts`). The timestamp-query implementation (`engine/gpu-task-timer.ts`) is reachable only through the dynamic import inside `setRenderTaskGpuTimingEnabled`.
3. Non-users do not fetch the profiler chunk and do not carry task-profiling code in the always-fetched frame-graph module. On enable, the dynamic profiler wraps the currently registered frame graphs' `execute()` functions, plus newly pushed surfaces/contexts, so timestamp passes are written only while profiling is explicitly enabled.

When enabled, the first timed task seen for a new frame encoder clears the current record list. The dynamic frame-graph wrapper writes an empty timestamped compute pass before and after each `Task` execution. After `renderFrame` submits the frame command buffer, one shared resolve hook dispatches frame timing first (when enabled) and task timing second. Task timing owns that hook directly when frame timing is off, so either profiler works independently without double-resolving when both are enabled. The task profiler resolves/copies the used query slots through a tiny follow-up command buffer, then maps a recycled readback buffer asynchronously. Results are one or more frames behind and include the existing `Task.name` label plus an execution-order `index` to disambiguate duplicate names. If the fixed query capacity is exceeded, excess tasks execute normally and `droppedTaskCount` reports how many were not timed.

Disabling task timing destroys its query set, resolve buffer, pooled readbacks, and any pending readback buffers. A readback that settles after disable is ignored, and re-enabling creates a fresh task timer. This intentionally differs from the frame timer above, whose smaller resource set is retained for reuse.

## State Machine / Lifecycle

```
[Created] --registerScene(scene)--> [Context registered + frame graph built]
          --startEngine(engine)-----------> [Running (rAF loop)]
                                                          |
                                                      resizeEngine(engine) each frame
                                                      _beforeRender(deltaMs) each frame
                                                      renderFrame() each frame
                                                          |
                                          --stopEngine(engine)----> [Stopped]
                                                          |
                                           --startEngine(engine)----------> [Running]
```

## Babylon.js Equivalence Map

| Babylon Lite                                   | Babylon.js                                                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createEngine(canvas)`                         | `new BABYLON.WebGPUEngine(canvas)` + `engine.initAsync()`                                                                                           |
| `engine._device`                               | `engine._device`                                                                                                                                    |
| `engine.format`                                | `engine._textureHelper._glslang.getPreferredFormat()`                                                                                               |
| `engine.msaaSamples` (1 or 4)                  | `engine._samples`                                                                                                                                   |
| `registerScene(scene)` + `startEngine(engine)` | `engine.runRenderLoop(() => scene.render())` — also similar to `scene.whenReadyAsync()` in that the returned Promise resolves after the first frame |
| `waitForGpuIdle(engine)`                       | `engine._device.queue.onSubmittedWorkDone()`                                                                                                        |
| `stopEngine(engine)`                           | `engine.stopRenderLoop()`                                                                                                                           |
| `resizeEngine(engine)`                         | `engine.resize()`                                                                                                                                   |
| Registered `RenderingContext`s                 | Engine render loop callbacks                                                                                                                        |
| Scene frame graph execution                    | Scene render graph / rendering manager                                                                                                              |
| `scene._prePasses` in `_update()`              | `scene.onBeforeRenderObservable` + shadow pre-work                                                                                                  |
| `scene._frameGraph.execute()`                  | Internal draw list dispatch                                                                                                                         |

## Dependencies

- **Ordering helper**: type-only imports of `RenderingContext` and `SurfaceContext`.
- **Utility overlay hooks**: engine and scene types, the ordering helper, and scene-overlay registration/configuration seams.
- **External**: WebGPU API (`navigator.gpu`, `GPUDevice`, `GPUCanvasContext`, etc.).

## Test Specification

| Test                                              | Description                                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `createEngine returns valid Engine`               | Mock `navigator.gpu`, verify all interface fields are populated                                |
| `resize only recreates targets when size changes` | Call resize with same dimensions → targets unchanged; change `clientWidth` → targets recreated |
| `start/stop manages rAF`                          | Verify `requestAnimationFrame` called on start, `cancelAnimationFrame` on stop                 |
| `waitForGpuIdle returns the queue fence`          | Verify `onSubmittedWorkDone()` is called once and its exact Promise is returned                |
| `renderFrame calls scene callbacks`               | Verify pre-passes → updaters → renderables order                                               |
| `rendering-context query is live and readonly`    | Verify stable array identity, registration-order updates, and public kind discriminators       |
| `rendering-context ordering`                      | Verify clamped moves, unregistered contexts, and stable utility-layer grouping and lifecycle   |
| `MSAA resolve target is swap chain view`          | Inspect color attachment `resolveTarget` in render pass descriptor                             |
| `depth format is depth24plus-stencil8`            | Verify `depthTexture.format`                                                                   |

## File Manifest

| File                                    | Size       | Purpose                                                                                                |
| --------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| `src/engine/engine.ts`                  | ~150 lines | Engine interface, creation, render loop, MSAA targets                                                  |
| `src/engine/rendering-context-order.ts` | ~20 lines  | Tree-shakable move operation for a surface's rendering-context registry                                |
| `src/scene/overlay-scene.ts`            | ~110 lines | Opt-in `createOverlayScene`, the installed registration seam, and contiguous ordering                  |
| `src/engine/engine-dispose.ts`          | ~25 lines  | Explicit engine teardown and synchronous resource-retirement drain                                     |
| `src/engine/gpu-resource-retirement.ts` | ~110 lines | Deferred retirement, exactly-once batch ownership, and awaitable teardown                              |
| `src/engine/gpu-timer.ts`               | ~110 lines | Optional GPU frame-time measurement (dynamic-imported by `setGpuTimingEnabled`; zero-cost when unused) |
| `src/engine/gpu-task-timing.ts`         | ~120 lines | Thin public per-task timing API; dynamic-imports the profiler implementation only when enabled         |
| `src/engine/gpu-task-timer.ts`          | ~150 lines | Optional timestamp-query implementation for per-frame-graph-task GPU timings                           |
