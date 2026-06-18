import type { Mesh } from "../mesh/mesh.js";
import type { Texture2D, Texture2DOptions } from "../texture/texture-2d.js";
import { _setHpmAllocator } from "../math/_matrix-allocator.js";
import type { SurfaceContext, SurfaceOptions } from "./surface.js";
import { _buildSurface, _refreshScRT, isDomCanvas, resizeSurface, setSurfaceSize } from "./surface.js";
import type { GpuFrameTimer } from "./gpu-timer.js";
import type { GpuTaskTimer } from "./gpu-task-timer.js";
import type { RenderTaskGpuTimings } from "./gpu-task-timing.js";

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

/**
 * Handle to the WebGPU engine — pure state, no attached methods.
 *
 * The engine owns the `GPUDevice` and all device-scoped GPU resources (textures, buffers,
 * pipelines, bind groups). It also **is itself a {@link SurfaceContext}** bound to the
 * canvas passed into `createEngine` — the primary surface. Additional canvases can be
 * attached via `createSurface(engine, canvas, ...)`; GPU resources are shared across all
 * surfaces because they're device-scoped, while each surface owns its own swapchain
 * context.
 */
export interface EngineContext extends SurfaceContext {
    /** Rendering surfaces attached to this engine, in registration order. Index 0 is
     *  the engine itself (the primary surface) — the tuple type guarantees at least
     *  one entry so `engine.surfaces[0]` is always defined. Use
     *  `createSurface(engine, canvas, ...)` to append more. */
    readonly surfaces: readonly [SurfaceContext, ...SurfaceContext[]];
    /** @internal Same array as {@link surfaces}, but typed as a mutable tuple so the
     *  module-internal mutators (`createSurface`, `disposeSurface`, `disposeEngine`)
     *  can splice into it without casting away the public readonly contract. */
    _surfaces: [SurfaceContext, ...SurfaceContext[]];

    /** Number of GPU draw calls in the last rendered frame, summed across all surfaces. */
    drawCallCount: number;

    /** GPU time spent on the last measured frame, in milliseconds — 0 until the first measured frame and
     *  while GPU timing is disabled (the default). Enable with {@link setGpuTimingEnabled}; query device
     *  capability with {@link isGpuTimingSupported}. Updates a frame or two behind, since the timestamp
     *  readback is async and off the render critical path, so reading it does not perturb the value. */
    gpuFrameTimeMs: number;
    /** @internal GPU frame timer, lazily created the first time GPU timing is enabled (null when the
     *  device is unsupported, undefined until the first {@link setGpuTimingEnabled} call dynamic-imports
     *  the timer module). */
    _gpuTimer?: GpuFrameTimer | null;
    /** @internal Per-frame timing hooks, defined exactly while GPU timing is enabled. {@link setGpuTimingEnabled}
     *  installs them (closing over the timer, from the dynamic-imported timer module) on enable and clears
     *  them on disable. {@link renderFrame} only optional-chains them, so none of the timer code is statically
     *  reachable from the always-bundled engine — scenes that never enable timing ship zero bytes of it
     *  (mirrors the screenshot `_captureService` hook). The timestamps are written *into the frame's command
     *  encoder* (begin first, end last) so the GPU executes them contiguously around just that frame's work;
     *  `_gpuTimerResolve` runs after the frame's submit to read the pair back asynchronously. */
    _gpuTimerBegin?: (encoder: GPUCommandEncoder) => void;
    /** @internal See `_gpuTimerBegin`. */
    _gpuTimerEnd?: (encoder: GPUCommandEncoder) => void;
    /** @internal See `_gpuTimerBegin`. Resolves the timestamp pair (async readback) and publishes `gpuFrameTimeMs`. */
    _gpuTimerResolve?: () => void;
    /** @internal Latest desired on/off state requested via {@link setGpuTimingEnabled}, used to apply the
     *  correct state if timing is toggled while the timer module is still being dynamic-imported. */
    _gpuTimerWanted?: boolean;
    /** @internal Lazily-created task GPU timer resources, owned by the optional profiler module. */
    _gpuTaskTimer?: GpuTaskTimer | null;
    /** @internal Latest desired on/off state for task GPU profiling while its dynamic import is pending. */
    _gpuTaskTimerWanted?: boolean;
    /** @internal Incremented on each task-profiler enable/disable so stale async readbacks cannot publish after a later toggle. */
    _gpuTaskTimerEpoch?: number;
    /** @internal Last public task-timing snapshot published by the optional profiler. */
    _gpuTaskTimingResult?: RenderTaskGpuTimings;
    /** @internal Restores frame graphs wrapped by the optional task GPU profiler. */
    _gpuTaskTimerDisable?: () => void;
    /** @internal Optional task-profiler resolver chained through `_gpuTimerResolve` after the frame command buffer is submitted. */
    _gpuTaskTimerResolve?: () => void;

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

    /** @internal */
    _device: GPUDevice;
    /** @internal */
    _dlr?: DeviceLostRecoveryCapture;
    /** @internal */
    _animFrameId: number;
    /** @internal */
    _renderFn: ((now: number) => void) | null;

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

    /** @internal Active-camera `worldMatrixVersion` for the lights UBO version,
     *  and the floating-origin offset applier for positional light entries.
     *  Both are set only when the engine was created with
     *  `useFloatingOrigin: true` (dynamic-imported from
     *  `large-world/floating-origin.js`). The lights UBO folds
     *  `engine._lightFoVersion?.(scene) ?? 0` into its version and calls
     *  `engine._applyLightFoOffset?.(scratch, scene)` after filling;
     *  non-LWR engines leave both undefined so the FO offset code stays out of
     *  their light bundles (mirrors `_makePackMeshWorld` for mesh worlds). */
    _lightFoVersion?: (scene: import("../scene/scene-core.js").SceneContext) => number;
    /** @internal See `_lightFoVersion`. */
    _applyLightFoOffset?: (data: Float32Array, scene: import("../scene/scene-core.js").SceneContext) => void;
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

/** @internal Return true if `context` is already registered on `surface`. */
export function isRenderingContextRegistered(surface: SurfaceContext, context: RenderingContext): boolean {
    return surface._renderingContexts.indexOf(context) !== -1;
}

/** @internal Register a rendering context with `surface`. Returns false if already present. */
export function registerRenderingContext(surface: SurfaceContext, context: RenderingContext): boolean {
    if (surface._renderingContexts.indexOf(context) !== -1) {
        return false;
    }
    surface._renderingContexts.push(context);
    return true;
}

/** @internal Unregister a rendering context from `surface`. Returns false if not present. */
export function unregisterRenderingContext(surface: SurfaceContext, context: RenderingContext): boolean {
    const list = surface._renderingContexts;
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
 * Options for `createEngine`. Per-surface options for the primary surface (the canvas
 * passed to `createEngine`) come from {@link SurfaceOptions} and are passed alongside
 * the engine options as a single union: `createEngine(canvas, opts: EngineOptions & SurfaceOptions)`.
 */
export interface EngineOptions extends SurfaceOptions {
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
}

/** Create the Babylon Lite engine bound to `canvas`. Acquires the GPU adapter + device,
 *  configures the canvas's WebGPU context, and returns an `EngineContext` that *is also*
 *  the primary `SurfaceContext` — i.e. the returned engine is itself the surface for the
 *  given canvas. Additional canvases can be attached afterwards via
 *  `createSurface(engine, otherCanvas, ...)`; they share device-scoped GPU resources
 *  (textures, meshes, pipelines, bind groups) with the engine and with each other.
 *
 *  Accepts either a DOM canvas (main thread) or an `OffscreenCanvas` (e.g. transferred
 *  to a Web Worker) — see {@link RenderCanvas}. */
export async function createEngine(canvas: RenderCanvas, options?: EngineOptions): Promise<EngineContext> {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
        throw new Error("WebGPU adapter not available");
    }

    const features: GPUFeatureName[] = [];
    if (adapter.features.has("float32-filterable")) {
        features.push("float32-filterable");
    }
    // `timestamp-query` is requested opportunistically (like the compression features above) so a later
    // `setGpuTimingEnabled` can measure GPU frame time. Requesting an available feature is free; the timer
    // itself ships only when `setGpuTimingEnabled` is called. Devices without it just can't enable timing.
    for (const f of ["texture-compression-astc", "texture-compression-bc", "texture-compression-etc2", "timestamp-query"] as GPUFeatureName[]) {
        if (adapter.features.has(f)) {
            features.push(f);
        }
    }
    const device = await adapter.requestDevice({ requiredFeatures: features, requiredLimits: options?.requiredLimits });

    const versionToLog = `Babylon Lite v${VERSION}`;
    // eslint-disable-next-line no-console
    console.log(`${versionToLog} - WebGPU engine`);
    if (isDomCanvas(canvas)) {
        canvas.setAttribute("data-engine", versionToLog);
    }

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
    // `docs/lite/architecture/36-high-precision-matrix.md`).
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
    let _lightFoVersion: EngineContext["_lightFoVersion"];
    let _applyLightFoOffset: EngineContext["_applyLightFoOffset"];
    if (useFO) {
        const [{ wrapRenderableForFO, lightFoVersion, applyLightFoOffset }, { makePackMeshWorld }] = await Promise.all([
            import("../large-world/floating-origin.js"),
            import("../large-world/pack-mat4-with-offset.js"),
        ]);
        _wrapRenderableForFO = wrapRenderableForFO;
        _makePackMeshWorld = makePackMeshWorld;
        _lightFoVersion = lightFoVersion;
        _applyLightFoOffset = applyLightFoOffset;
    }

    // The engine extends `SurfaceContext`, so we need to assemble both the engine-only
    // fields AND the per-canvas surface fields onto a single object. `_buildSurface`
    // reads `engine._device` at call time, so we seed the object with `_device` up front;
    // `Object.assign` then evaluates both source expressions (the engine-only literal and
    // the `_buildSurface` result) before copying, letting us merge both in one call. The
    // `surfaces` field is the same array as `_surfaces`, exposed publicly as a readonly tuple.
    const engine = { _device: device } as EngineContext;
    const surfaces: [EngineContext, ...SurfaceContext[]] = [engine];
    Object.assign(
        engine,
        {
            engine, // self-reference: the engine IS its primary surface
            surfaces, // public readonly view of `_surfaces` (same underlying array)
            _surfaces: surfaces,
            _device: device,
            drawCallCount: 0,
            gpuFrameTimeMs: 0,
            useHighPrecisionMatrix: useHpm,
            useFloatingOrigin: useFO,
            _animFrameId: 0,
            _renderFn: null,
            _currentEncoder: undefined,
            _currentDelta: 0,
            _cbs: [],
            _wrapRenderableForFO,
            _makePackMeshWorld,
            _lightFoVersion,
            _applyLightFoOffset,
        } satisfies Partial<EngineContext>,
        _buildSurface(engine, canvas, options)
    );

    // Size the canvas backing store first (so the swap texture is acquired at the final
    // size), then populate the swapchain target from the first current texture so its
    // `_colorView`/`_width`/`_height` are non-null before the frame graph builds.
    resizeSurface(engine);
    _refreshScRT(engine);

    return engine;
}

/** Resize every surface attached to this engine (including the engine's own primary
 *  surface). For DOM-canvas surfaces, snaps the swapchain backing store to the current
 *  `clientWidth × clientHeight × devicePixelRatio` (capped by each surface's
 *  `maxDevicePixelRatio`). For `OffscreenCanvas` surfaces this is a no-op per surface —
 *  call `setSurfaceSize` on the specific surface instead, since an `OffscreenCanvas`
 *  has no layout. */
export function resizeEngine(engine: EngineContext): void {
    for (const surface of engine.surfaces) {
        resizeSurface(surface);
    }
}

/** Set the engine's primary-surface swapchain backing-store size directly, in device
 *  pixels. Convenience wrapper around `setSurfaceSize(engine, w, h)` since the engine
 *  *is* its own primary surface — for auxiliary surfaces, prefer calling `setSurfaceSize`
 *  on the specific target. */
export function setEngineSize(engine: EngineContext, widthPx: number, heightPx: number): void {
    setSurfaceSize(engine, widthPx, heightPx);
}

/** @internal Return the canvas-backed render target dimensions for a surface (or the
 *  engine, since the engine itself is a surface). In the frame-graph architecture,
 *  render targets are owned by `RenderingContext`s rather than the engine itself;
 *  this helper exposes the swapchain size for callers that just need it. */
export function getRenderTargetSize(surface: SurfaceContext): RenderTargetSize {
    const c = surface.canvas;
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

/** Release all engine-owned GPU resources (device + every attached surface's swapchain
 *  context). Rendering contexts own their own GPU resources (frame graphs, render
 *  targets) and dispose them separately. */
export function disposeEngine(engine: EngineContext): void {
    stopEngine(engine);
    const surfaces = engine._surfaces;
    for (const s of surfaces) {
        s._renderingContexts.length = 0;
        s._context.unconfigure();
    }
    surfaces.length = 0;
    engine._device.destroy();
}

export function renderFrame(engine: EngineContext, delta: number): void {
    const surfaces = engine.surfaces;
    // `surfaces` is typed as a non-empty tuple — the engine itself is always at
    // index 0 — so we don't need to guard against an empty list. Still skip the
    // encoder allocation if no surface has any rendering contexts.
    let total = 0;
    for (let i = 0; i < surfaces.length; i++) {
        total += surfaces[i]!._renderingContexts.length;
    }
    if (total === 0) {
        return;
    }

    const encoder = engine._device.createCommandEncoder({ label: "frame" });
    engine._currentEncoder = encoder;
    engine._currentDelta = delta;

    // Optional GPU timing: write the frame's opening timestamp into the frame encoder. `_gpuTimerBegin`
    // is undefined unless timing is enabled (its hooks are installed/removed by `setGpuTimingEnabled` from
    // a dynamic-imported module), so a frame that never enabled timing pays only this short-circuit and
    // ships none of the timer code. The begin/end pair is written *into* the encoder so the GPU executes
    // them contiguously around this frame's passes — measuring only the frame's own GPU work.
    engine._gpuTimerBegin?.(encoder);

    let drawCalls = 0;
    for (let i = 0; i < surfaces.length; i++) {
        const surface = surfaces[i]!;
        // A queued screenshot (`captureScreenshot`) needs this surface's swapchain marked COPY_SRC
        // before its frame texture is acquired — reconfiguring the context EXPIRES the current
        // canvas texture, so it cannot run mid-frame. The hook is installed lazily by
        // `captureScreenshot`, so non-capturing surfaces ship none of the reconfigure code and pay
        // only this short-circuit.
        surface._capturePreFrame?.(surface);
        _refreshScRT(surface);
        const ctxs = surface._renderingContexts;
        for (let j = 0; j < ctxs.length; j++) {
            const s = ctxs[j]!;
            s._update();
            drawCalls += s._drawCallsPre;
            drawCalls += s._record();
        }
    }

    const finalEncoder = engine._currentEncoder;
    // Per-surface screenshot readback hook — undefined (a no-op optional call) until
    // `captureScreenshot(surface)` lazily installs it on that surface, so surfaces that
    // never capture keep this to a single short-circuit and ship none of the readback code.
    // Each service records its surface's swapchain copy into this frame's encoder.
    for (let i = 0; i < surfaces.length; i++) {
        const surface = surfaces[i]!;
        surface._captureService?.(surface, finalEncoder);
    }
    // Closing timestamp goes in just before the frame encoder is finished, so it bookends exactly the
    // frame's recorded GPU work (a no-op short-circuit when timing is disabled).
    engine._gpuTimerEnd?.(finalEncoder);
    engine._cbs[0] = finalEncoder.finish();
    engine._device.queue.submit(engine._cbs);
    engine.drawCallCount = drawCalls;
    // Resolve + read back the timestamp pair asynchronously (its own submit, after the frame's) and
    // publish the latest completed sample to `gpuFrameTimeMs`. Non-blocking — never stalls this frame.
    engine._gpuTimerResolve?.();
}

/** Whether GPU frame-time measurement is available on this engine's device — i.e. the adapter offered
 *  the WebGPU `timestamp-query` feature (requested opportunistically by {@link createEngine}). When false,
 *  {@link setGpuTimingEnabled} is a no-op and {@link EngineContext.gpuFrameTimeMs} stays 0. */
export function isGpuTimingSupported(engine: EngineContext): boolean {
    return engine._device.features.has("timestamp-query");
}

/** Enable or disable per-frame GPU timing. Disabled by default and a no-op on devices where
 *  {@link isGpuTimingSupported} is false. While on, {@link EngineContext.gpuFrameTimeMs} is updated each
 *  frame with the measured GPU time — the time the GPU spends on that frame's work, not CPU/wall-clock
 *  time — a frame or two behind via an async, non-blocking readback.
 *
 *  Implementation: the timer module is dynamic-imported on the first enable, so engines that never call
 *  this ship none of it. Once loaded, three tiny per-frame hooks are installed on the engine; while timing
 *  is off they are undefined and {@link renderFrame} only optional-chains them (a no-op short-circuit), so
 *  scenes that never enable timing pay effectively nothing. The opening/closing timestamps are written into
 *  the frame's command encoder so the GPU runs them contiguously around just that frame's passes. The first
 *  enable takes effect a microtask later (the GPU resources are created lazily, then reused); subsequent
 *  toggles are synchronous. */
export function setGpuTimingEnabled(engine: EngineContext, enabled: boolean): void {
    if (!enabled) {
        // Clear the hooks (renderFrame's optional-chains go back to no-ops) but keep `_gpuTimer` so its
        // GPU resources are reused if timing is re-enabled later. Preserve the task-profiler resolve hook
        // when per-task timing is enabled independently.
        engine._gpuTimerWanted = false;
        engine.gpuFrameTimeMs = 0;
        engine._gpuTimerBegin = undefined;
        engine._gpuTimerEnd = undefined;
        engine._gpuTimerResolve = engine._gpuTaskTimerResolve;
        return;
    }
    if (!isGpuTimingSupported(engine)) {
        return;
    }
    engine._gpuTimerWanted = true;
    // Dynamic import (module-cached after the first load — re-enabling triggers no extra fetch). The timer
    // is created once and reused; its free functions are wired into the per-frame hooks renderFrame calls.
    void import("./gpu-timer.js").then(({ createGpuFrameTimer, gpuFrameTimerBegin, gpuFrameTimerEnd, gpuFrameTimerResolve }) => {
        if (engine._gpuTimer === undefined) {
            engine._gpuTimer = createGpuFrameTimer(engine._device);
        }
        const timer = engine._gpuTimer;
        // Honour the latest intent — the caller may have toggled timing off again while we loaded.
        if (timer && engine._gpuTimerWanted) {
            engine._gpuTimerBegin = (encoder) => gpuFrameTimerBegin(timer, encoder);
            engine._gpuTimerEnd = (encoder) => gpuFrameTimerEnd(timer, encoder);
            engine._gpuTimerResolve = () => {
                gpuFrameTimerResolve(timer);
                engine.gpuFrameTimeMs = timer.lastMs;
                engine._gpuTaskTimerResolve?.();
            };
        }
    });
}
