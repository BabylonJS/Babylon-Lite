import type { Mesh } from "../mesh/mesh.js";
import type { Texture2D, Texture2DOptions } from "../texture/texture-2d.js";
import { _setHpmAllocator } from "../math/_matrix-allocator.js";
import type { RenderTarget } from "./render-target.js";
import { createRenderTarget } from "./render-target.js";

/** Babylon Lite version string. */
export const VERSION = "0.1.0";

// Module-scoped visibility epoch. setSubtreeVisible (scene/visibility.ts,
// loaded only by KHR_node_visibility / KHR_animation_pointer features) bumps
// this. Per-scene bundle caches compare against it for invalidation.
export let _vis = 0;
export function bumpVisibilityEpoch(): void {
    _vis = (_vis + 1) | 0;
}

/**
 * A surface Babylon Lite can render into. Either a DOM canvas (main thread) or an
 * `OffscreenCanvas` (e.g. one transferred to a Web Worker via
 * `transferControlToOffscreen()`). Both expose `getContext("webgpu")` plus a
 * read/write backing-store `width`/`height`; only the DOM canvas exposes layout
 * (`clientWidth`/`clientHeight`) and attributes (`setAttribute`).
 */
export type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;

/** @internal Type guard: true for a DOM canvas (has layout + attributes). */
function isDomCanvas(canvas: RenderCanvas): canvas is HTMLCanvasElement {
    return "clientWidth" in canvas;
}

/** Handle to the WebGPU engine — pure state, no attached methods. */
export interface EngineContext {
    readonly canvas: RenderCanvas;
    readonly msaaSamples: number;
    /** Preferred GPU texture format for the swapchain. Use as the `format`
     *  for offscreen RTs that are sampled by main-pass materials. */
    readonly format: GPUTextureFormat;

    /**
     * Engine-owned color-only render target that wraps the canvas swapchain texture.
     * Its `_colorTexture`/`_colorView` are re-acquired from `context.getCurrentTexture()`
     * once per frame (see `_refreshScRT`), so it is always single-sample and
     * carries no depth. Render/post-process/copy tasks target it (or resolve into it) to
     * present to the canvas. It is `_eager` — `buildRenderTarget` and `disposeRenderTarget`
     * both no-op on it and the engine owns its textures, so its shared `_descriptor` must
     * never be mutated.
     */
    readonly scRT: RenderTarget;

    /** Number of GPU draw calls in the last rendered frame. */
    drawCallCount: number;

    /**
     * When true, world matrices are computed using Float64 intermediate precision
     * and downcast to Float32 at GPU upload time. Defaults to false.
     */
    useHighPrecisionMatrix: boolean;

    /**
     * When true, every scene on this engine uses the floating-origin (eye-relative
     * upload) trick to render large-world coordinates without F32 jitter. Requires
     * `useHighPrecisionMatrix: true`. Defaults to false.
     *
     * LWR is engine-wide: all scenes created against this engine inherit the
     * mode. The LWR runtime module (`large-world/floating-origin.js`) is
     * dynamically imported during `createEngine` only when this flag is true,
     * so non-LWR engines never pull the module into their bundle.
     */
    useFloatingOrigin: boolean;

    /** Clamps the effective device pixel ratio used for the swapchain backing store.
     *  The backing store is sized at `min(devicePixelRatio, maxDevicePixelRatio) * cssPixels`.
     *  `maxDevicePixelRatio = 1` renders at native CSS-pixel resolution (no DPR upscaling);
     *  the default `Infinity` is unclamped (full devicePixelRatio). Mutable at runtime — set
     *  before the next `resizeEngine` to take effect (mirrors `setHardwareScalingRatio`). */
    maxDevicePixelRatio: number;

    /** @internal */
    _device: GPUDevice;
    /** @internal */
    readonly _context: GPUCanvasContext;
    /** @internal */
    readonly _alphaMode: GPUCanvasAlphaMode;
    /** @internal */
    _dlr?: DeviceLostRecoveryCapture;
    /** @internal */
    _animFrameId: number;
    /** @internal */
    _renderFn: ((now: number) => void) | null;
    /** @internal Registered rendering contexts in render order (first clears; subsequent overlay). */
    _renderingContexts: RenderingContext[];

    // ─── Per-frame transient state ─────────────────────────────────────
    /** @internal Encoder being filled this frame. Set by `renderFrame` before each context's
     *  `_update`/`_record`; consumed by frame-graph tasks and pre-passes. */
    _currentEncoder: GPUCommandEncoder;
    /** @internal Frame delta in ms (read by scenes that don't override fixedDeltaMs). */
    _currentDelta: number;
    /** @internal */
    _cbs: GPUCommandBuffer[];

    /** @internal Per-frame floating-origin offset updater. Set when the engine
     *  was created with `useFloatingOrigin: true` (which requires
     *  `useHighPrecisionMatrix: true`). Undefined when FO is off — scene
     *  `_update` does `eng._updateFOOffset?.(scene)` so FO-off engines never
     *  pull the LWR module (`large-world/floating-origin.js`) into their
     *  bundle. The function reads `scene.camera.worldMatrix` and writes the
     *  resulting world position into `scene._floatingOriginOffset`, bumping
     *  `scene._floatingOriginVersion` whenever the value changes. */
    _updateFOOffset?: (scene: import("../scene/scene-core.js").SceneContext) => void;

    /** @internal Per-renderable update closure wrapper. Set when the engine
     *  was created with `useFloatingOrigin: true`. Wraps a renderable's bare
     *  `update` closure so that when `scene._floatingOriginVersion` changes,
     *  the wrapper calls `invalidate()` (which resets the renderable's
     *  `_lastWorldVersion` to -1) before invoking the inner update — forcing
     *  the next mesh-UBO re-pack to pick up the new FO offset. Undefined when
     *  FO is off, so non-LWR renderables skip FO version tracking entirely
     *  and stay in the slim shared closure (~80-150 bytes lighter per bundle
     *  for FO-off scenes). */
    _wrapRenderableForFO?: (inner: () => void, scene: import("../scene/scene-core.js").SceneContext, invalidate: () => void) => () => void;

    /** @internal Factory that produces a mesh-world UBO packer with the
     *  scene's floating-origin offset captured. Set when the engine was
     *  created with `useFloatingOrigin: true`. Renderables resolve their
     *  packer once at construction with
     *  `engine._makePackMeshWorld?.(scene) ?? packMat4IntoF32`; non-LWR
     *  engines leave it undefined and renderables fall through to the bare
     *  precision-only packer. Splitting the offset-subtracting variant out
     *  of the always-bundled packer (BJS-style "method override when LWR is
     *  on") keeps the 3 subtraction lines + the `_foOffset` captures out of
     *  non-LWR bundles (~140 bytes saved per FO-off bundle). */
    _makePackMeshWorld?: (
        scene: import("../scene/scene-core.js").SceneContext
    ) => (view: Float32Array, mat: import("../math/types.js").Mat4 | Float32Array | Float64Array, offsetFloats: number, srcOffsetFloats: number) => void;
}

/**
 * Minimal surface an engine sees for anything it renders. Scenes (and any other
 * future renderable thing) register themselves as a `RenderingContext` and
 * own their own update / record logic. Engine knows nothing of scene internals.
 */
export interface RenderingContext {
    /** @internal Draw calls produced by pre-pass work during `_update` (shadows + pre-passes). */
    _drawCallsPre: number;
    /** Clear color used when this context is the first active one in a frame. */
    clearColor: GPUColorDict;
    /** @internal Run per-frame update work (beforeRender hooks, shadow + pre-passes, UBO updates,
     *  transparent sort). Reads / mutates engine state via `engine._currentEncoder` and
     *  `engine._currentDelta`. */
    _update(): void;
    /** @internal Drive this context's GPU work — typically delegates to
     *  `frameGraph.execute()`. Returns draw-call count. */
    _record(): number;
    /** @internal Optional. Called by the engine when the canvas backing-store size changes.
     *  Implementations should rebuild any canvas-sized GPU resources (e.g. ask
     *  their frame graph to rebuild so render targets get re-allocated). */
    _resize?(): void;
}

/** @internal */
interface DeviceLostRecoveryCapture {
    u(tex: Texture2D, url: string, opts: Texture2DOptions): void;
    s(tex: Texture2D, r: number, g: number, b: number, a: number): void;
    b(tex: Texture2D, bitmap: ImageBitmap | null, srgb: boolean, mipMaps: boolean, fallback?: Uint8Array): void;
    m(
        mesh: Mesh,
        uv2s: Float32Array | null | undefined,
        tangents: Float32Array | null | undefined,
        colors: Float32Array | null | undefined,
        gpuIndices: Uint16Array | Uint32Array,
        indexFormat: GPUIndexFormat
    ): void;
}

/** @internal Return true if `context` is already registered with `engine`. */
export function isRenderingContextRegistered(engine: EngineContext, context: RenderingContext): boolean {
    return engine._renderingContexts.indexOf(context) !== -1;
}

/** @internal Register a rendering context with the engine. Returns false if already present. */
export function registerRenderingContext(engine: EngineContext, context: RenderingContext): boolean {
    if (isRenderingContextRegistered(engine, context)) {
        return false;
    }
    engine._renderingContexts.push(context);
    return true;
}

/** @internal Unregister a rendering context from the engine. Returns false if not present. */
export function unregisterRenderingContext(engine: EngineContext, context: RenderingContext): boolean {
    const list = engine._renderingContexts;
    const i = list.indexOf(context);
    if (i === -1) {
        return false;
    }
    list.splice(i, 1);
    return true;
}

export interface RenderTargetSize {
    readonly width: number;
    readonly height: number;
}

/**
 * Options for `createEngine`.
 * - `msaaSamples`: number of MSAA samples to use for the main render pass.
 *   WebGPU only permits `1` (no MSAA) or `4` (4x MSAA) per the spec
 *   (2x is not a valid WebGPU sample count). Defaults to `4`.
 */
export interface EngineOptions {
    msaaSamples?: 1 | 4;
    /**
     * WebGPU canvas alpha mode. Use "premultiplied" to enable canvas transparency (clear color
     * with `alpha < 1` will let HTML content underneath show through). Defaults to "opaque".
     */
    alphaMode?: GPUCanvasAlphaMode;
    /**
     * Extra WebGPU device limits to request when calling `adapter.requestDevice()`.
     * Use to raise per-device caps such as `maxColorAttachmentBytesPerSample` (default 32),
     * which is required when rendering into many MRT attachments. Caller is responsible for
     * staying within the adapter's reported limits.
     */
    requiredLimits?: Record<string, GPUSize64 | undefined>;
    /**
     * Enable Float64 intermediate precision for world matrix computations. Defaults to false.
     */
    useHighPrecisionMatrix?: boolean;
    /**
     * Enable floating-origin (Large World Rendering) for every scene on this engine.
     * Requires `useHighPrecisionMatrix: true` — throws synchronously if set without it.
     * Defaults to false.
     *
     * When true, `createEngine` dynamically imports the LWR runtime
     * (`large-world/floating-origin.js`) so engines without LWR never pull the
     * module into their bundle (tree-shaken via the dynamic-import gate, same
     * pattern as the F64 storage module).
     */
    useFloatingOrigin?: boolean;
    /**
     * Clamps the effective device pixel ratio used for the swapchain backing store.
     * The backing store is sized at `min(devicePixelRatio, maxDevicePixelRatio) * cssPixels`.
     * `maxDevicePixelRatio: 1` renders at native CSS-pixel resolution (no DPR upscaling) —
     * useful on high-DPI/iOS devices where `devicePixelRatio` is ~3. Defaults to unclamped
     * (full devicePixelRatio). Equivalent to Babylon.js `setHardwareScalingRatio`.
     */
    maxDevicePixelRatio?: number;
}

/** Create the Babylon Lite engine. Acquires GPU adapter + device, configures swapchain.
 *  Accepts either a DOM canvas (main thread) or an `OffscreenCanvas` (e.g. transferred to
 *  a Web Worker) — see {@link RenderCanvas}. */
export async function createEngine(canvas: RenderCanvas, options?: EngineOptions): Promise<EngineContext> {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
        throw new Error("WebGPU adapter not available");
    }

    const features: GPUFeatureName[] = [];
    if (adapter.features.has("float32-filterable")) {
        features.push("float32-filterable");
    }
    for (const f of ["texture-compression-astc", "texture-compression-bc", "texture-compression-etc2"] as GPUFeatureName[]) {
        if (adapter.features.has(f)) {
            features.push(f);
        }
    }
    const device = await adapter.requestDevice({ requiredFeatures: features, requiredLimits: options?.requiredLimits });
    const context = canvas.getContext("webgpu");
    if (!context) {
        throw new Error("WebGPU context not available");
    }

    const format = navigator.gpu.getPreferredCanvasFormat();
    const alphaMode: GPUCanvasAlphaMode = options?.alphaMode ?? "opaque";
    context.configure({ device, format, alphaMode });

    const versionToLog = `Babylon Lite v${VERSION}`;
    // eslint-disable-next-line no-console
    console.log(`${versionToLog} - WebGPU engine`);
    if (isDomCanvas(canvas)) {
        canvas.setAttribute("data-engine", versionToLog);
    }

    const msaaSamples: 1 | 4 = options?.msaaSamples === 1 ? 1 : 4;

    const useHpm = options?.useHighPrecisionMatrix === true;
    const useFO = options?.useFloatingOrigin === true;
    if (useFO && !useHpm) {
        throw new Error("Babylon Lite: useFloatingOrigin requires useHighPrecisionMatrix on the engine.");
    }
    // Dynamic `await import` keeps the F64 backing module out of HPM-off
    // bundles entirely: bundlers cannot prove the truthy branch of a runtime
    // ternary is dead, so a static import of `_mat4-storage-f64.js` was
    // retained in every bundle even with `sideEffects: false`. Splitting it
    // behind `if (useHpm)` lets HPM-off builds drop the module; HPM-on builds
    // load it as a side chunk on demand and install the F64 allocator into
    // the process-global lazy singleton in `_matrix-allocator.ts`. The
    // allocator module itself is statically imported above — it's the
    // F64-specific module that we gate dynamically.
    // **Constraint:** allocator is process-global — mixing HPM and non-HPM
    // engines on the same page is unsupported (see
    // `docs/architecture/33-high-precision-matrix.md`).
    if (useHpm) {
        const { allocateF64Mat4 } = await import("../math/_mat4-storage-f64.js");
        _setHpmAllocator(allocateF64Mat4);
    }

    // Same dynamic-import trick for the LWR runtime. When `useFloatingOrigin` is
    // false (the default) the `floating-origin.js` module is never referenced
    // statically anywhere in the package — scene `_update` does
    // `eng._updateFOOffset?.(scene)` which is a no-op when the field is
    // undefined. Tree-shakers drop the module from non-LWR bundles.
    let _wrapRenderableForFO: EngineContext["_wrapRenderableForFO"];
    let _makePackMeshWorld: EngineContext["_makePackMeshWorld"];
    if (useFO) {
        const [{ wrapRenderableForFO }, { makePackMeshWorld }] = await Promise.all([
            import("../large-world/floating-origin.js"),
            import("../large-world/pack-mat4-with-offset.js"),
        ]);
        _wrapRenderableForFO = wrapRenderableForFO;
        _makePackMeshWorld = makePackMeshWorld;
    }

    // Engine-owned swapchain target — a color-only, single-sample RT that wraps the
    // canvas texture. `_eager` so `buildRenderTarget` skips it; the engine refreshes its
    // textures each frame from `context.getCurrentTexture()`.
    const scRT = createRenderTarget({ lbl: "swapchain", format: format, samples: 1, size: "canvas" });
    scRT._eager = true;

    const engine: EngineContext = {
        _device: device,
        _context: context,
        format,
        scRT,
        _alphaMode: alphaMode,
        canvas,
        msaaSamples,
        drawCallCount: 0,
        useHighPrecisionMatrix: useHpm,
        useFloatingOrigin: useFO,
        maxDevicePixelRatio: options?.maxDevicePixelRatio ?? Infinity,
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
        _currentEncoder: undefined!,
        _currentDelta: 0,
        _cbs: [],
        _wrapRenderableForFO,
        _makePackMeshWorld,
    };

    // Size the canvas backing store first (so the swap texture is acquired at the final
    // size), then populate the swapchain target from the first current texture so its
    // `_colorView`/`_width`/`_height` are non-null before the frame graph builds.
    resizeEngine(engine);
    _refreshScRT(engine);

    return engine;
}

/** @internal Re-acquire the canvas swapchain texture into `engine.scRT`.
 *  WebGPU returns a fresh `GPUTexture` from `getCurrentTexture()` each frame, so this
 *  is called once per frame (in `renderFrame`, before contexts record) — and again
 *  after `createEngine`/device-loss reconfigure — to keep the engine-owned target
 *  pointing at the live canvas texture. */
export function _refreshScRT(engine: EngineContext): void {
    const tex = engine._context.getCurrentTexture();
    const swap = engine.scRT;
    swap._colorTexture = tex;
    swap._colorView = tex.createView();
    swap._width = tex.width;
    swap._height = tex.height;
}

/** Resize the swapchain backing-store to match the canvas client size. When the size
 *  changes, asks every registered rendering context to rebuild its canvas-sized GPU
 *  resources via the optional `_resize` hook. If the canvas has not been laid out yet,
 *  preserves its explicit backing-store size.
 *
 *  Only DOM canvases are auto-sized from layout here. An `OffscreenCanvas` has no layout
 *  box, so its size is pushed in externally via {@link setEngineSize} (e.g. from the host
 *  thread that owns the visible canvas) and this call is a no-op for it. */
export function resizeEngine(engine: EngineContext): void {
    const canvas = engine.canvas;
    if (!isDomCanvas(canvas)) {
        return;
    }
    const clientWidth = canvas.clientWidth;
    const clientHeight = canvas.clientHeight;
    if (!(clientWidth > 0 && clientHeight > 0)) {
        return;
    }
    const scale = Math.min(globalThis.devicePixelRatio || 1, engine.maxDevicePixelRatio);
    const w = (clientWidth * scale) | 0;
    const h = (clientHeight * scale) | 0;
    setEngineSize(engine, w, h);
}

/** Set the swapchain backing-store size directly, in device pixels. Use this when the
 *  engine renders into an `OffscreenCanvas` whose layout size is only known on another
 *  thread (the host posts the CSS size × devicePixelRatio). When the size changes, asks
 *  every registered rendering context to rebuild its canvas-sized GPU resources via the
 *  optional `_resize` hook. */
export function setEngineSize(engine: EngineContext, widthPx: number, heightPx: number): void {
    const canvas = engine.canvas;
    const w = widthPx | 0;
    const h = heightPx | 0;
    if (!(w > 0 && h > 0)) {
        return;
    }
    if (w === canvas.width && h === canvas.height) {
        return;
    }
    canvas.width = w;
    canvas.height = h;
    // Keep the engine swapchain target's dimensions in sync with the canvas. Canvas-sized
    // reads happen at frame-graph build time (e.g. the blur post-process derives its texel
    // step from `outputTexture._width`), before the next frame re-acquires the swap texture.
    engine.scRT._width = w;
    engine.scRT._height = h;
    for (const c of engine._renderingContexts) {
        c._resize?.();
    }
}

/** @internal Return the canvas-backed render target dimensions. In the frame-graph
 *  architecture, render targets are owned by `RenderingContext`s rather than the
 *  engine itself; this helper exposes the canvas size for callers that just need
 *  the swapchain dimensions (e.g. sprite renderer). */
export function getRenderTargetSize(engine: EngineContext): RenderTargetSize {
    const c = engine.canvas;
    return { width: c.width, height: c.height };
}

/**
 * Start the render loop. Resolves after the first frame has been rendered.
 * Scenes registered via `registerScene()` before this call are included in
 * the first frame; later registrations join on subsequent frames.
 */
export function startEngine(engine: EngineContext): Promise<void> {
    return new Promise<void>((resolve) => {
        let firstRafFrame = true;
        let lastTime = 0;
        engine._renderFn = (now: number) => {
            const delta = firstRafFrame ? 0 : lastTime > 0 ? now - lastTime : 16.667;
            lastTime = now;
            resizeEngine(engine);
            renderFrame(engine, delta);
            if (firstRafFrame) {
                firstRafFrame = false;
                resolve();
            }
            engine._animFrameId = requestAnimationFrame(engine._renderFn!);
        };
        engine._animFrameId = requestAnimationFrame(engine._renderFn);
    });
}

/** Stop the render loop. */
export function stopEngine(engine: EngineContext): void {
    if (engine._animFrameId) {
        cancelAnimationFrame(engine._animFrameId);
    }
    engine._animFrameId = 0;
    engine._renderFn = null;
}

/** Release all engine-owned GPU resources (device + swapchain). Rendering contexts
 *  own their own GPU resources (frame graphs, render targets) and dispose them
 *  separately. */
export function disposeEngine(engine: EngineContext): void {
    stopEngine(engine);
    engine._renderingContexts.length = 0;
    engine._context.unconfigure();
    engine._device.destroy();
}

export function renderFrame(engine: EngineContext, delta: number): void {
    const ctxs = engine._renderingContexts;
    if (ctxs.length === 0) {
        return;
    }

    const encoder = engine._device.createCommandEncoder({ label: "frame" });
    engine._currentEncoder = encoder;
    engine._currentDelta = delta;
    _refreshScRT(engine);

    let drawCalls = 0;
    for (let i = 0; i < ctxs.length; i++) {
        const s = ctxs[i]!;
        s._update();
        drawCalls += s._drawCallsPre;
        drawCalls += s._record();
    }

    const finalEncoder = engine._currentEncoder;
    engine._cbs[0] = finalEncoder.finish();
    engine._device.queue.submit(engine._cbs);
    engine.drawCallCount = drawCalls;
}
