# Module: Engine
> Package path: `packages/babylon-lite/src/engine/engine.ts`

## Purpose

The Engine module is the lowest layer of Babylon Lite. It acquires a WebGPU adapter and device, configures the swap chain on an HTML canvas, creates MSAA and depth/stencil render targets, and drives the per-frame render loop via `requestAnimationFrame`. All other modules depend on the Engine for GPU device access and frame orchestration.

## Public API Surface

```typescript
/** Handle to the WebGPU engine — public API surface.
 *  GPU internals (device, context, format) are @internal (EngineContextInternal) — not user-facing. */
export interface EngineContext {
  readonly canvas: HTMLCanvasElement;
  readonly msaaSamples: number;           // always 4

  /** GPU draw calls executed in the last rendered frame. */
  drawCallCount: number;
}

/** Start the render loop for the given scene. Resolves after the first frame renders. */
export function startEngine(engine: EngineContext, scene: SceneContext): Promise<void>;
/** Stop the render loop. */
export function stopEngine(engine: EngineContext): void;
/** Resize render targets to match canvas size. */
export function resizeEngine(engine: EngineContext): void;
/** Release all engine-owned GPU resources (render targets, device). */
export function disposeEngine(engine: EngineContext): void;

/** Create the Babylon Lite engine. Acquires GPU adapter + device, configures swapchain. */
export async function createEngine(canvas: HTMLCanvasElement): Promise<EngineContext>;
```

### Internal Types (not exported)

```typescript
/** @internal — GPU internals accessible only to renderable/loader code. */
interface EngineContextInternal extends EngineContext {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
}

interface RenderTargets {
  msaaTexture: GPUTexture;
  msaaView: GPUTextureView;
  depthTexture: GPUTexture;
  depthView: GPUTextureView;
  width: number;
  height: number;
}
```

## Internal Architecture

### Initialization Sequence (`createEngine`)

1. **Adapter request**: `navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })` — throws if WebGPU unavailable.
2. **Device request**: `adapter.requestDevice({ requiredFeatures })` — optionally enables `float32-filterable` if supported.
3. **Canvas context**: `canvas.getContext('webgpu')` — throws if context unavailable.
4. **Swap chain configure**: `context.configure({ device, format, alphaMode: 'opaque' })` where `format = navigator.gpu.getPreferredCanvasFormat()`.
5. **MSAA**: Hard-coded to `msaaSamples = 4`.
6. **Render targets**: Creates initial MSAA color and depth/stencil textures matching canvas dimensions.

### Render Targets (`createRenderTargets`)

| Texture | Format | SampleCount | Usage |
|---|---|---|---|
| `msaaTexture` | `navigator.gpu.getPreferredCanvasFormat()` (e.g. `bgra8unorm`) | 4 | `RENDER_ATTACHMENT` |
| `depthTexture` | `depth24plus-stencil8` | 4 | `RENDER_ATTACHMENT` |

Both textures are sized to `(width, height)` and views are created immediately.

### Resize Logic

Called at the **start of every frame** (inside the rAF callback), not on a resize event:

```
w = canvas.clientWidth * devicePixelRatio | 0
h = canvas.clientHeight * devicePixelRatio | 0
if (w == targets.width && h == targets.height) return;
canvas.width = w; canvas.height = h;
context.configure({ device, format, alphaMode: 'opaque' });
targets.msaaTexture.destroy();
targets.depthTexture.destroy();
targets = createRenderTargets(device, w, h, format, msaaSamples);
```

The bitwise OR with 0 (`| 0`) truncates to integer.

### Render Loop

`startEngine(engine, scene)` returns a `Promise<void>` that resolves after the first frame has been rendered:

```
startEngine(engine, scene):
  await buildScene(scene)          // runs all deferred builders
  sort scene._renderables by order
  return new Promise(resolve => {
    renderFn = (now) => {
      resizeEngine(engine);
      deltaMs = now - prev (or scene._fixedDeltaMs if set)
      call scene._beforeRender callbacks with deltaMs
      renderFrame(engine, targets, scene);
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

The `_beforeRender` callbacks receive `deltaMs` (milliseconds since the previous frame). If `scene._fixedDeltaMs` is set, that value is used instead — useful for deterministic animation playback.

### Frame Rendering (`renderFrame`)

Each frame consists of:

1. **Obtain swap chain view**: `engine.context.getCurrentTexture().createView()`.
2. **Create command encoder**: `device.createCommandEncoder()`.
3. **Pre-render passes**: Iterate `scene._prePasses` — call each `execute(encoder, engine)`. Used for shadow depth passes, blur passes, compute, etc.
4. **Begin main render pass**:
   - Color attachment: `view = targets.msaaView`, `resolveTarget = swapChainView`, `clearValue = scene.clearColor`, `loadOp = 'clear'`, `storeOp = 'store'`.
   - Depth/stencil attachment: `view = targets.depthView`, `depthClearValue = 1.0`, `depthLoadOp = 'clear'`, `depthStoreOp = 'store'`, `stencilClearValue = 0`, `stencilLoadOp = 'clear'`, `stencilStoreOp = 'store'`.
5. **Set viewport**: `pass.setViewport(0, 0, targets.width, targets.height, 0, 1)`.
6. **Update uniforms**: Iterate `scene._uniformUpdaters` — call each `update(engine)`. Writes camera, light, fog data to UBOs.
7. **Draw calls**: Iterate `scene._renderables` (sorted by `order` at start) — call each `draw(pass, engine)`. Each renderable dispatches its own draw calls.
8. **End pass and submit**: `pass.end()`, `device.queue.submit([encoder.finish()])`.

### Deferred Builder Execution

When `startEngine(engine, scene)` is called:
1. **Await** `buildScene(scene)` — runs all deferred builders (creates pipelines, bind groups, renderables). This is async because builders may perform async work.
2. Sort `scene._renderables` by `order` (ascending)
3. Begin the rAF render loop
4. The returned Promise resolves after the first `renderFrame()` call completes

The 4× MSAA texture (`targets.msaaView`) is automatically resolved to the swap chain texture (`swapChainView`) by the WebGPU runtime because `resolveTarget` is set in the color attachment.

## State Machine / Lifecycle

```
[Created] --startEngine(engine, scene)--> [Building (await buildScene)] --> [Running (rAF loop)]
                                                          |
                                                      resizeEngine(engine) each frame
                                                      _beforeRender(deltaMs) each frame
                                                      renderFrame() each frame
                                                          |
                                          --stopEngine(engine)----> [Stopped]
                                                          |
                                          --startEngine(engine, scene)----> [Building] --> [Running]
```

## Babylon.js Equivalence Map

| Babylon Lite | Babylon.js |
|---|---|
| `createEngine(canvas)` | `new BABYLON.WebGPUEngine(canvas)` + `engine.initAsync()` |
| `engine.device` | `engine._device` |
| `engine.format` | `engine._textureHelper._glslang.getPreferredFormat()` |
| `engine.msaaSamples` (always 4) | `engine._samples` (configurable) |
| `startEngine(engine, scene)` | `engine.runRenderLoop(() => scene.render())` — also similar to `scene.whenReadyAsync()` in that the returned Promise resolves after the first frame |
| `stopEngine(engine)` | `engine.stopRenderLoop()` |
| `resizeEngine(engine)` | `engine.resize()` |
| MSAA render targets | Engine internally manages MSAA framebuffers |
| `scene._prePasses` iteration | `scene.onBeforeRenderObservable` |
| `scene._uniformUpdaters` iteration | Internal UBO update during frame |
| `scene._renderables` iteration | Internal draw list dispatch |

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
