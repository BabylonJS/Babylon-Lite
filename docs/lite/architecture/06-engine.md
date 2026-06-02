# Module: Engine
> Package path: `packages/babylon-lite/src/engine/engine.ts`

## Purpose

The Engine module is the lowest layer of Babylon Lite. It acquires a WebGPU adapter and device, configures the swap chain on a render canvas, creates MSAA and depth/stencil render targets, and drives the per-frame render loop via `requestAnimationFrame`. All other modules depend on the Engine for GPU device access and frame orchestration.

The render canvas may be either a DOM `HTMLCanvasElement` (main thread) or an `OffscreenCanvas` (e.g. one transferred to a Web Worker via `transferControlToOffscreen()`). The engine runs unchanged in both cases — see *Offscreen / Worker Rendering* below.

## Public API Surface

```typescript
/** A surface the engine can render into: a DOM canvas or an OffscreenCanvas. */
export type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Handle to the WebGPU engine — public API surface.
 *  GPU internals (device, context, format) are @internal (EngineContextInternal) — not user-facing. */
export interface EngineContext {
  readonly canvas: RenderCanvas;
  readonly msaaSamples: number;           // 1 or 4
  readonly format: GPUTextureFormat;

  /** GPU draw calls executed in the last rendered frame. */
  drawCallCount: number;
}

/** Start the render loop for all registered rendering contexts. Resolves after the first frame renders. */
export function startEngine(engine: EngineContext): Promise<void>;
/** Stop the render loop. */
export function stopEngine(engine: EngineContext): void;
/** Resize render targets to match canvas layout size. No-op for an OffscreenCanvas. */
export function resizeEngine(engine: EngineContext): void;
/** Set the backing-store size directly in device pixels (used for OffscreenCanvas). */
export function setEngineSize(engine: EngineContext, widthPx: number, heightPx: number): void;
/** Release all engine-owned GPU resources (render targets, device). */
export function disposeEngine(engine: EngineContext): void;

/** Create the Babylon Lite engine. Acquires GPU adapter + device, configures swapchain. */
export async function createEngine(canvas: RenderCanvas, options?: EngineOptions): Promise<EngineContext>;
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
2. **Device request**: `adapter.requestDevice({ requiredFeatures })` — optionally enables `float32-filterable` if supported.
3. **Canvas context**: `canvas.getContext('webgpu')` — throws if context unavailable.
4. **Swap chain configure**: `context.configure({ device, format, alphaMode })` where `format = navigator.gpu.getPreferredCanvasFormat()` and `alphaMode = options?.alphaMode ?? "opaque"`.
5. **MSAA**: Defaults to `msaaSamples = 4`, or `1` when requested.
6. **Rendering contexts**: Initializes an empty `_renderingContexts` list. Scenes and other renderers register themselves with the engine.

### Render Targets

The engine no longer owns per-frame color/depth render targets directly. Render targets are owned by registered rendering contexts, primarily scene frame-graph `RenderTask`s. The engine owns the canvas/swapchain and exposes the current swapchain view once per frame through `_swapchainView`.

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

- `createEngine` skips the `setAttribute("data-engine", …)` tag for it (guarded by a DOM-canvas check).
- `resizeEngine` is a **no-op** for it — the visible canvas lives on another thread.
- The host thread (which owns the visible canvas) measures the CSS size, multiplies by `devicePixelRatio`, and posts those device-pixel dimensions to the worker, which calls `setEngineSize(engine, w, h)`. This both sets the backing store **and** fires `_resize()` hooks so canvas-sized GPU resources rebuild.

Everything else (adapter/device acquisition, `getContext("webgpu")`, the rAF render loop) is identical — dedicated workers in Chromium expose `requestAnimationFrame`/`cancelAnimationFrame`. See the **Offscreen** lab demo (`lab/lite/src/demos/offscreen*.ts`) for an end-to-end main-thread-vs-worker example.

### Render Loop

`startEngine(engine)` returns a `Promise<void>` that resolves after the first frame has been rendered. Any scene registered before the call participates in the first frame; later registrations join on subsequent frames.

```
registerScene(engine, scene):
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

Each frame consists of:

1. **Create command encoder**: `device.createCommandEncoder({ label: "frame" })` and assign `engine._currentEncoder`.
2. **Obtain swapchain view**: `engine.context.getCurrentTexture().createView()` and assign `engine._swapchainView`.
3. **Update/record contexts**: For each registered `RenderingContext`, call `_update()` then `_record()`.
   - A scene `_update()` runs before-render callbacks, material swaps, shadow maps, legacy pre-passes, and shared uniform updaters.
   - A scene `_record()` delegates to `scene._frameGraph.execute()`.
4. **Submit**: finish the command encoder and submit via the reusable `engine._cbs` array to avoid per-frame array allocation.

### Deferred Builder Execution

When `registerScene(engine, scene)` is called, the scene runs its deferred builders, builds material renderables, and rebuilds its frame graph. `startEngine(engine)` then begins the rAF loop and resolves after the first `renderFrame()` call completes.

Swapchain MSAA/depth attachments are managed by the default scene `RenderTask` through render-target helpers, not by the engine render loop itself.

## State Machine / Lifecycle

```
[Created] --registerScene(engine, scene)--> [Context registered + frame graph built]
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

| Babylon Lite | Babylon.js |
|---|---|
| `createEngine(canvas)` | `new BABYLON.WebGPUEngine(canvas)` + `engine.initAsync()` |
| `engine.device` | `engine._device` |
| `engine.format` | `engine._textureHelper._glslang.getPreferredFormat()` |
| `engine.msaaSamples` (1 or 4) | `engine._samples` |
| `registerScene(engine, scene)` + `startEngine(engine)` | `engine.runRenderLoop(() => scene.render())` — also similar to `scene.whenReadyAsync()` in that the returned Promise resolves after the first frame |
| `stopEngine(engine)` | `engine.stopRenderLoop()` |
| `resizeEngine(engine)` | `engine.resize()` |
| Registered `RenderingContext`s | Engine render loop callbacks |
| Scene frame graph execution | Scene render graph / rendering manager |
| `scene._prePasses` in `_update()` | `scene.onBeforeRenderObservable` + shadow pre-work |
| `scene._frameGraph.execute()` | Internal draw list dispatch |

## Dependencies

- **Imports**: `SceneContext` from `../scene/scene.js` (type-only, for `start()` parameter).
- **External**: WebGPU API (`navigator.gpu`, `GPUDevice`, `GPUCanvasContext`, etc.).
- **No other internal dependencies.**

## Test Specification

| Test | Description |
|---|---|
| `createEngine returns valid Engine` | Mock `navigator.gpu`, verify all interface fields are populated |
| `resize only recreates targets when size changes` | Call resize with same dimensions → targets unchanged; change `clientWidth` → targets recreated |
| `start/stop manages rAF` | Verify `requestAnimationFrame` called on start, `cancelAnimationFrame` on stop |
| `renderFrame calls scene callbacks` | Verify pre-passes → updaters → renderables order |
| `MSAA resolve target is swap chain view` | Inspect color attachment `resolveTarget` in render pass descriptor |
| `depth format is depth24plus-stencil8` | Verify `depthTexture.format` |

## File Manifest

| File | Size | Purpose |
|---|---|---|
| `src/engine/engine.ts` | ~150 lines | Engine interface, creation, render loop, MSAA targets |
