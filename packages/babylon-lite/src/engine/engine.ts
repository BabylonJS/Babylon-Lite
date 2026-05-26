import type { MeshInternal } from "../mesh/mesh.js";
import type { Texture2D, Texture2DOptions } from "../texture/texture-2d.js";

/** Babylon Lite version string. */
export const VERSION = "0.1.0";

// Module-scoped visibility epoch. setSubtreeVisible (scene/visibility.ts,
// loaded only by KHR_node_visibility / KHR_animation_pointer features) bumps
// this. Per-scene bundle caches compare against it for invalidation.
export let _vis = 0;
export function bumpVisibilityEpoch(): void {
    _vis = (_vis + 1) | 0;
}

/** Handle to the WebGPU engine — pure state, no attached methods. */
export interface EngineContext {
    readonly canvas: HTMLCanvasElement;
    readonly msaaSamples: number;
    /** Preferred GPU texture format for the swapchain. Use as the `colorFormat`
     *  for offscreen RTs that are sampled by main-pass materials. */
    readonly format: GPUTextureFormat;

    /** Number of GPU draw calls in the last rendered frame. */
    drawCallCount: number;
}

/**
 * Minimal surface an engine sees for anything it renders. Scenes (and any other
 * future renderable thing) register themselves as a `RenderingContext` and
 * own their own update / record logic. Engine knows nothing of scene internals.
 */
export interface RenderingContext {
    /** Draw calls produced by pre-pass work during `_update` (shadows + pre-passes). */
    _drawCallsPre: number;
    /** Clear color used when this context is the first active one in a frame. */
    clearColor: GPUColorDict;
    /** Run per-frame update work (beforeRender hooks, shadow + pre-passes, UBO updates,
     *  transparent sort). Reads / mutates engine state via `engine._currentEncoder` and
     *  `engine._currentDelta`. */
    _update(): void;
    /** Drive this context's GPU work — typically delegates to
     *  `frameGraph.execute()`. Returns draw-call count. */
    _record(): number;
    /** Optional. Called by the engine when the canvas backing-store size changes.
     *  Implementations should rebuild any canvas-sized GPU resources (e.g. ask
     *  their frame graph to rebuild so render targets get re-allocated). */
    _resize?(): void;
}

interface DeviceLostRecoveryCapture {
    u(tex: Texture2D, url: string, opts: Texture2DOptions): void;
    s(tex: Texture2D, r: number, g: number, b: number, a: number): void;
    b(tex: Texture2D, bitmap: ImageBitmap | null, srgb: boolean, mipMaps: boolean, fallback?: Uint8Array): void;
    m(
        mesh: MeshInternal,
        uv2s: Float32Array | null | undefined,
        tangents: Float32Array | null | undefined,
        colors: Float32Array | null | undefined,
        gpuIndices: Uint16Array | Uint32Array,
        indexFormat: GPUIndexFormat
    ): void;
}

/** @internal Engine with GPU internals exposed. Not re-exported from index.ts. */
export interface EngineContextInternal extends EngineContext {
    device: GPUDevice;
    readonly context: GPUCanvasContext;
    readonly alphaMode: GPUCanvasAlphaMode;
    _dlr?: DeviceLostRecoveryCapture;
    _animFrameId: number;
    _renderFn: ((now: number) => void) | null;
    /** Registered rendering contexts in render order (first clears; subsequent overlay). */
    _renderingContexts: RenderingContext[];

    // ─── Per-frame transient state ─────────────────────────────────────
    /** Encoder being filled this frame. Set by `renderFrame` before each context's
     *  `_update`/`_record`; consumed by frame-graph tasks and pre-passes. */
    _currentEncoder: GPUCommandEncoder;
    /** Swapchain view acquired once per frame before contexts record. */
    _swapchainView: GPUTextureView;
    /** Frame delta in ms (read by scenes that don't override fixedDeltaMs). */
    _currentDelta: number;
    _cbs: GPUCommandBuffer[];
}

/** @internal Return true if `context` is already registered with `engine`. */
export function isRenderingContextRegistered(engine: EngineContext, context: RenderingContext): boolean {
    return (engine as EngineContextInternal)._renderingContexts.indexOf(context) !== -1;
}

/** @internal Register a rendering context with the engine. Returns false if already present. */
export function registerRenderingContext(engine: EngineContext, context: RenderingContext): boolean {
    if (isRenderingContextRegistered(engine, context)) {
        return false;
    }
    (engine as EngineContextInternal)._renderingContexts.push(context);
    return true;
}

/** @internal Unregister a rendering context from the engine. Returns false if not present. */
export function unregisterRenderingContext(engine: EngineContext, context: RenderingContext): boolean {
    const list = (engine as EngineContextInternal)._renderingContexts;
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
     * with alpha < 1 will let HTML content underneath show through). Defaults to "opaque".
     */
    alphaMode?: GPUCanvasAlphaMode;
}

/** Create the Babylon Lite engine. Acquires GPU adapter + device, configures swapchain. */
export async function createEngine(canvas: HTMLCanvasElement, options?: EngineOptions): Promise<EngineContext> {
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
    const device = await adapter.requestDevice({ requiredFeatures: features });
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
    if (canvas.setAttribute) {
        canvas.setAttribute("data-engine", versionToLog);
    }

    const msaaSamples: 1 | 4 = options?.msaaSamples === 1 ? 1 : 4;

    const engine: EngineContextInternal = {
        device,
        context,
        format,
        alphaMode,
        canvas,
        msaaSamples,
        drawCallCount: 0,
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
        _currentEncoder: undefined!,
        _swapchainView: undefined!,
        _currentDelta: 0,
        _cbs: [],
    };

    resizeEngine(engine);

    return engine;
}

/** Resize the swapchain backing-store to match the canvas client size. When the size
 *  changes, asks every registered rendering context to rebuild its canvas-sized GPU
 *  resources via the optional `_resize` hook. If the canvas has not been laid out yet,
 *  preserves its explicit backing-store size. */
export function resizeEngine(engine: EngineContext): void {
    const eng = engine as EngineContextInternal;
    const canvas = eng.canvas;
    const clientWidth = canvas.clientWidth;
    const clientHeight = canvas.clientHeight;
    if (!(clientWidth > 0 && clientHeight > 0)) {
        return;
    }
    const scale = globalThis.devicePixelRatio || 1;
    const w = (clientWidth * scale) | 0;
    const h = (clientHeight * scale) | 0;
    if (w === canvas.width && h === canvas.height) {
        return;
    }
    canvas.width = w;
    canvas.height = h;
    for (const c of eng._renderingContexts) {
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
    const eng = engine as EngineContextInternal;
    return new Promise<void>((resolve) => {
        let firstRafFrame = true;
        let lastTime = 0;
        eng._renderFn = (now: number) => {
            const delta = firstRafFrame ? 0 : lastTime > 0 ? now - lastTime : 16.667;
            lastTime = now;
            resizeEngine(engine);
            renderFrame(eng, delta);
            if (firstRafFrame) {
                firstRafFrame = false;
                resolve();
            }
            eng._animFrameId = requestAnimationFrame(eng._renderFn!);
        };
        eng._animFrameId = requestAnimationFrame(eng._renderFn);
    });
}

/** Stop the render loop. */
export function stopEngine(engine: EngineContext): void {
    const eng = engine as EngineContextInternal;
    if (eng._animFrameId) {
        cancelAnimationFrame(eng._animFrameId);
    }
    eng._animFrameId = 0;
    eng._renderFn = null;
}

/** Release all engine-owned GPU resources (device + swapchain). Rendering contexts
 *  own their own GPU resources (frame graphs, render targets) and dispose them
 *  separately. */
export function disposeEngine(engine: EngineContext): void {
    const eng = engine as EngineContextInternal;
    stopEngine(engine);
    eng._renderingContexts.length = 0;
    eng.context.unconfigure();
    eng.device.destroy();
}

function renderFrame(engine: EngineContextInternal, delta: number): void {
    const ctxs = engine._renderingContexts;
    if (ctxs.length === 0) {
        return;
    }

    const encoder = engine.device.createCommandEncoder({ label: "frame" });
    engine._currentEncoder = encoder;
    engine._currentDelta = delta;
    engine._swapchainView = engine.context.getCurrentTexture().createView();

    let drawCalls = 0;
    for (let i = 0; i < ctxs.length; i++) {
        const s = ctxs[i]!;
        s._update();
        drawCalls += s._drawCallsPre;
        drawCalls += s._record();
    }

    const finalEncoder = engine._currentEncoder;
    engine._cbs[0] = finalEncoder.finish();
    engine.device.queue.submit(engine._cbs);
    engine.drawCallCount = drawCalls;
}
