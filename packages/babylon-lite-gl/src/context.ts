import type { GLEffect } from "./effect.js";
import type { GLTexture } from "./texture.js";
import type { GLRenderTarget } from "./render-target.js";
import { createGLState, resetGLState, resetGLStateCache, type GLState } from "./state.js";

/**
 * Minimal shape of a context-restorable GL buffer (vertex / index), kept local
 * to this module so the public `GLEngineContext` type carries no dependency on
 * the tree-shakeable `mesh` entry. `mesh.ts`'s `GLVertexBuffer` /
 * `GLIndexBuffer` satisfy it structurally.
 * @internal
 */
export interface GLManagedBuffer {
    handle: WebGLBuffer;
    /** @internal */
    _disposed: boolean;
    /** @internal */
    _deleteGpu: (gl: WebGL2RenderingContext) => void;
    /** @internal */
    _restore: (engine: GLEngineContext) => void;
}

/** Constructor options forwarded to `canvas.getContext('webgl2', …)`. */
export interface GLEngineOptions {
    /** Default: true. */
    alpha?: boolean;
    /** Default: true. */
    premultipliedAlpha?: boolean;
    /** Default: false. */
    antialias?: boolean;
    /** Default: false. */
    preserveDrawingBuffer?: boolean;
    /** Default: false — disabled for fullscreen-quad workloads. */
    depth?: boolean;
    /** Default: false. */
    stencil?: boolean;
    /** Default: "default". */
    powerPreference?: WebGLPowerPreference;
    /** Default: false. */
    failIfMajorPerformanceCaveat?: boolean;
}

/** Read-only WebGL2 capability limits, queried once at context creation. */
export interface GLEngineCaps {
    /** `gl.MAX_TEXTURE_SIZE` — largest supported texture dimension, in texels. */
    readonly maxTextureSize: number;
    /** `gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS` — number of sampler binding slots. */
    readonly maxTextureUnits: number;
    /** The `KHR_parallel_shader_compile` extension used for async link polling,
     *  or null when unsupported — linking is then treated as synchronous. */
    readonly parallelShaderCompile: { COMPLETION_STATUS_KHR: number } | null;
    /** True when 32-bit float color attachments are renderable
     *  (`EXT_color_buffer_float`). Mirrors Babylon's `caps.textureFloatRender`. */
    readonly textureFloatRender: boolean;
    /** True when 32-bit float textures support linear filtering
     *  (`OES_texture_float_linear`). Mirrors `caps.textureFloatLinearFiltering`. */
    readonly textureFloatLinearFiltering: boolean;
    /** True when 16-bit half-float color attachments are renderable
     *  (`EXT_color_buffer_float` or `EXT_color_buffer_half_float`). Mirrors
     *  `caps.textureHalfFloatRender`. */
    readonly textureHalfFloatRender: boolean;
    /** Half-float linear filtering — always `true` in WebGL2 (it is core).
     *  Kept as a field to mirror Babylon's `caps.textureHalfFloatLinearFiltering`. */
    readonly textureHalfFloatLinearFiltering: boolean;
    /** Whether non-power-of-two textures need POT dimensions for mips / wrap.
     *  Always `false` in WebGL2 (NPOT is core). Mirrors `engine.needPOTTextures`. */
    readonly needPOTTextures: boolean;
}

/**
 * Pure-state handle for a WebGL2 canvas + its cached GL state.
 *
 * INVARIANT: consumers MUST NOT mutate GL state directly through `engine.gl`.
 * Doing so silently corrupts the cache in `_state`. The package owns every
 * GL call. (`engine.gl` is exposed only so downstream code that already has the
 * pattern of poking `engine._gl.getExtension(...)` can do that, but must NOT
 * call `bindTexture`/`useProgram`/`bindBuffer`/`viewport`/etc.)
 */
export interface GLEngineContext {
    /** The canvas the WebGL2 context was acquired from. An `OffscreenCanvas` is
     *  supported for worker render paths (e.g. the Lottie player); it has no CSS
     *  box, so it must be sized explicitly via `setGLEngineSize` rather than the
     *  CSS-derived `resizeGLEngine`. */
    readonly canvas: HTMLCanvasElement | OffscreenCanvas;
    /** The raw WebGL2 context. Do NOT mutate GL state through it — see the
     *  type-level invariant above; the package owns every state-changing call. */
    readonly gl: WebGL2RenderingContext;
    /** Queried capability limits for this context. */
    readonly caps: GLEngineCaps;
    /**
     * Hardware-scaling-level — drawingBufferWidth = clientWidth * dpr / _hsl.
     * @internal
     */
    _hsl: number;
    /**
     * rAF id when a render loop is active, 0 otherwise.
     * @internal
     */
    _rafId: number;
    /**
     * Per-frame callbacks. `runRenderLoop` is a no-op if `fn` is already
     * registered (matches Babylon `AbstractEngine.runRenderLoop`).
     * @internal
     */
    _loops: ((dt: number) => void)[];
    /**
     * Timestamp of last frame for delta computation.
     * @internal
     */
    _prevNow: number;
    /**
     * Cached GL state. See §4 of 00-lite-gl.md.
     * @internal
     */
    _state: GLState;
    /**
     * Live effect registry — populated by `createEffect`, removed by
     * `disposeEffect`. Used by the context-restored protocol to rebuild
     * programs.
     * @internal
     */
    _effects: GLEffect[];
    /**
     * Per-engine effect cache keyed by source descriptor (vertex+fragment
     * source, defines, attribute/uniform/sampler names). `createEffect` returns
     * (and ref-counts) the cached `GLEffect` when an identical descriptor is
     * requested, so identical shaders share ONE WebGLProgram — letting
     * `useEffect`'s current-program cache elide redundant `gl.useProgram`.
     * @internal
     */
    _effectCache: Map<string, GLEffect>;
    /**
     * Live texture registry — populated by `createRawTexture` /
     * `loadTexture2D` / `createHtmlElementTexture`. Used by the
     * context-restored protocol to replay uploads.
     * @internal
     */
    _textures: GLTexture[];
    /**
     * Live render-target registry — populated by `createRenderTarget`. Used by
     * the context-restored protocol to rebuild framebuffers + attachments after
     * their color textures have been replayed. Empty (and tree-shaken) when the
     * render-target module is unused.
     * @internal
     */
    _renderTargets: GLRenderTarget[];
    /**
     * The render target currently bound for drawing (`bindRenderTarget`), or
     * `null` for the default canvas framebuffer. Tracked so that leaving a
     * mipmapped target (`bindRenderTarget(engine, null)` or switching to
     * another target) can regenerate its mip chain — mirroring Babylon's
     * auto-mipmap on `unBindFramebuffer`. Reset to `null` on context-lost.
     * @internal
     */
    _currentRenderTarget: GLRenderTarget | null;
    /**
     * Live vertex / index buffer registry — populated by `createVertexBuffer` /
     * `createIndexBuffer`. Used by the context-restored protocol to re-upload
     * the retained CPU data into fresh GL buffers. Empty (and tree-shaken) when
     * the mesh module is unused.
     * @internal
     */
    _buffers: GLManagedBuffer[];
    /** @internal */
    _onLost: (() => void)[];
    /** @internal */
    _onRestored: (() => void)[];
    /**
     * True between `webglcontextlost` and `webglcontextrestored`. While
     * true, every `setEffect*` / `bindTexture` / `drawEffect` is a no-op.
     * @internal
     */
    _isLost: boolean;
    /**
     * True once the context has been disposed; subsequent calls become no-ops.
     * @internal
     */
    _disposed: boolean;
    /**
     * DOM handlers — retained so dispose can `removeEventListener` them.
     * @internal
     */
    _lostHandler: (e: Event) => void;
    /** @internal */
    _restoredHandler: () => void;
    /**
     * True when a render loop was active at the moment of `webglcontextlost`,
     * so we can resume it from the restored handler.
     * @internal
     */
    _wasLoopActive: boolean;
    /**
     * Installed by `runRenderLoop` on first call. Lets the context-restored
     * handler resume a loop without a circular runtime import from render-loop.
     * Null if the render-loop module is tree-shaken out.
     * @internal
     */
    _scheduleFrame: ((engine: GLEngineContext) => void) | null;
}

/** Acquire a WebGL2 context on the canvas and build the pure-state handle.
 *  Accepts an `HTMLCanvasElement` or an `OffscreenCanvas` (worker render paths —
 *  e.g. the Lottie player — which size the drawing buffer via `setGLEngineSize`).
 *  Throws if WebGL2 is unsupported. */
export function createGLEngine(canvas: HTMLCanvasElement | OffscreenCanvas, options?: GLEngineOptions): GLEngineContext {
    const o = options ?? {};
    const attrs: WebGLContextAttributes = {
        alpha: o.alpha ?? true,
        premultipliedAlpha: o.premultipliedAlpha ?? true,
        antialias: o.antialias ?? false,
        preserveDrawingBuffer: o.preserveDrawingBuffer ?? false,
        depth: o.depth ?? false,
        stencil: o.stencil ?? false,
        powerPreference: o.powerPreference ?? "default",
        failIfMajorPerformanceCaveat: o.failIfMajorPerformanceCaveat ?? false,
    };
    const gl = canvas.getContext("webgl2", attrs) as WebGL2RenderingContext | null;
    if (gl === null) {
        throw new Error("lite-gl: WebGL2 is not supported on this canvas");
    }

    const parallelExt = gl.getExtension("KHR_parallel_shader_compile") as { COMPLETION_STATUS_KHR: number } | null;
    // Probe color-buffer-float support. `getExtension` both queries AND enables
    // the extension, so this call is what makes float/half-float attachments
    // renderable for the render-target module.
    const colorBufferFloat = gl.getExtension("EXT_color_buffer_float") !== null;
    const colorBufferHalfFloat = gl.getExtension("EXT_color_buffer_half_float") !== null;
    const floatLinear = gl.getExtension("OES_texture_float_linear") !== null;
    const caps: GLEngineCaps = {
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
        maxTextureUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number,
        parallelShaderCompile: parallelExt,
        textureFloatRender: colorBufferFloat,
        textureFloatLinearFiltering: floatLinear,
        // In WebGL2, EXT_color_buffer_float also makes RGBA16F renderable; the
        // half-float-only extension is the fallback for drivers exposing just it.
        textureHalfFloatRender: colorBufferFloat || colorBufferHalfFloat,
        // Half-float linear filtering is core in WebGL2 (no extension needed).
        textureHalfFloatLinearFiltering: true,
        // NPOT textures are core in WebGL2 — mips/wrap work at any size.
        needPOTTextures: false,
    };

    const engine: GLEngineContext = {
        canvas,
        gl,
        caps,
        _hsl: 1,
        _rafId: 0,
        _loops: [],
        _prevNow: 0,
        _state: createGLState(caps.maxTextureUnits),
        _effects: [],
        _effectCache: new Map(),
        _textures: [],
        _renderTargets: [],
        _currentRenderTarget: null,
        _buffers: [],
        _onLost: [],
        _onRestored: [],
        _isLost: false,
        _disposed: false,
        _lostHandler: () => {},
        _restoredHandler: () => {},
        _wasLoopActive: false,
        _scheduleFrame: null,
    };

    engine._lostHandler = (e: Event) => handleContextLost(engine, e);
    engine._restoredHandler = () => handleContextRestored(engine);
    canvas.addEventListener("webglcontextlost", engine._lostHandler as EventListener, false);
    canvas.addEventListener("webglcontextrestored", engine._restoredHandler, false);

    return engine;
}

/** Stops the render loop, removes DOM listeners, releases all known effects
 *  and textures, then marks the context disposed. The browser-owned canvas
 *  is left intact. */
export function disposeGLEngine(engine: GLEngineContext): void {
    if (engine._disposed) {
        return;
    }
    engine._disposed = true;
    if (engine._rafId !== 0) {
        cancelAnimationFrame(engine._rafId);
        engine._rafId = 0;
    }
    engine._loops.length = 0;
    engine.canvas.removeEventListener("webglcontextlost", engine._lostHandler as EventListener, false);
    engine.canvas.removeEventListener("webglcontextrestored", engine._restoredHandler, false);

    const gl = engine.gl;
    // Iterate snapshots — the dispose paths splice into the registries.
    const effects = engine._effects.slice();
    for (const eff of effects) {
        if (!eff._disposed) {
            eff._disposed = true;
            eff.isReady = false;
            gl.deleteProgram(eff.program);
            gl.deleteShader(eff._vs);
            gl.deleteShader(eff._fs);
        }
    }
    engine._effects.length = 0;
    engine._effectCache.clear();
    const textures = engine._textures.slice();
    for (const tex of textures) {
        if (!tex._disposed) {
            tex._disposed = true;
            gl.deleteTexture(tex.handle);
        }
    }
    engine._textures.length = 0;
    // Render targets own their FBO + renderbuffer + color texture; free them via
    // the per-RT closure so context.ts needs no runtime import of render-target.
    const rts = engine._renderTargets.slice();
    for (const rt of rts) {
        if (!rt._disposed) {
            rt._disposed = true;
            rt._deleteGpu(gl);
        }
    }
    engine._renderTargets.length = 0;

    // Mesh vertex/index buffers own a single GL buffer each; free via closure.
    const buffers = engine._buffers.slice();
    for (const buf of buffers) {
        if (!buf._disposed) {
            buf._disposed = true;
            buf._deleteGpu(gl);
        }
    }
    engine._buffers.length = 0;

    resetGLState(engine._state);
    engine._currentRenderTarget = null;
    engine._onLost.length = 0;
    engine._onRestored.length = 0;
}

/** Match drawing-buffer size to (clientSize × devicePixelRatio / _hsl). No-op
 *  if size already matches. Never touches viewport — `setViewport` owns that. */
export function resizeGLEngine(engine: GLEngineContext): void {
    if (engine._disposed || engine._isLost) {
        return;
    }
    const canvas = engine.canvas;
    // An OffscreenCanvas has no CSS box (no clientWidth/clientHeight); it is sized
    // explicitly via setGLEngineSize, so CSS-derived auto-resize is a no-op for it.
    if (!("clientWidth" in canvas)) {
        return;
    }
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const w = Math.max(1, Math.floor((canvas.clientWidth * dpr) / engine._hsl));
    const h = Math.max(1, Math.floor((canvas.clientHeight * dpr) / engine._hsl));
    if (canvas.width !== w) {
        canvas.width = w;
    }
    if (canvas.height !== h) {
        canvas.height = h;
    }
}

/**
 * Set the drawing-buffer size to an EXPLICIT width/height in physical pixels
 * (each divided by `_hsl`), independent of the canvas client/CSS size — the
 * counterpart of Babylon's `ThinEngine.setSize`. Use when the render resolution
 * is computed directly (e.g. animation dimensions × scale × dpr) rather than
 * derived from CSS layout via {@link resizeGLEngine}. No-op on a disposed
 * engine. Never touches the viewport — `setViewport` owns that.
 *
 * @param engine - The engine to resize.
 * @param width - Target drawing-buffer width in physical pixels.
 * @param height - Target drawing-buffer height in physical pixels.
 */
export function setGLEngineSize(engine: GLEngineContext, width: number, height: number): void {
    if (engine._disposed) {
        return;
    }
    const canvas = engine.canvas;
    const w = Math.max(1, Math.floor(width / engine._hsl));
    const h = Math.max(1, Math.floor(height / engine._hsl));
    if (canvas.width !== w) {
        canvas.width = w;
    }
    if (canvas.height !== h) {
        canvas.height = h;
    }
}

/**
 * Invalidate lite-gl's cached GL state so the next state-setting call in each
 * category (program / buffer / texture / VAO / framebuffer bindings, blend,
 * depth, stencil, scissor, color-mask, viewport, unpack) is re-issued instead
 * of elided.
 *
 * Use this when a host application that SHARES this WebGL2 context mutates raw
 * `gl.*` state outside lite-gl — e.g. a save/restore wrapper that resets the
 * context to GL defaults around each render scope, or any interop layer that
 * issues GL calls directly. Without it, lite-gl's redundant-call elision would
 * skip the state changes needed to re-establish the scope, producing corrupted
 * output. Owned GPU resources (the shared quad, render targets, meshes,
 * effects, textures) are preserved — only the cached "current GL state" is
 * reset. Mirrors Babylon's `Engine.wipeCaches()`.
 *
 * No-op while the context is lost or the engine is disposed.
 */
export function wipeGLStateCache(engine: GLEngineContext): void {
    if (engine._disposed || engine._isLost) {
        return;
    }
    resetGLStateCache(engine._state);
}

/** Drawing-buffer width in physical pixels (`canvas.width`). */
export function getRenderWidth(engine: GLEngineContext): number {
    return engine.canvas.width;
}

/** Drawing-buffer height in physical pixels (`canvas.height`). */
export function getRenderHeight(engine: GLEngineContext): number {
    return engine.canvas.height;
}

/** Current hardware-scaling factor — drawing-buffer = clientSize × dpr / level. */
export function getHardwareScalingLevel(engine: GLEngineContext): number {
    return engine._hsl;
}

/** Updates the hardware-scaling factor and triggers a resize. */
export function setHardwareScalingLevel(engine: GLEngineContext, level: number): void {
    if (level <= 0 || !isFinite(level)) {
        return;
    }
    engine._hsl = level;
    resizeGLEngine(engine);
}

/** The backing canvas element (an `HTMLCanvasElement`, or an `OffscreenCanvas`
 *  for worker render paths). */
export function getRenderingCanvas(engine: GLEngineContext): HTMLCanvasElement | OffscreenCanvas {
    return engine.canvas;
}

/** Register a `webglcontextlost` callback. Duplicate registrations are ignored. */
export function onContextLost(engine: GLEngineContext, cb: () => void): void {
    if (engine._onLost.indexOf(cb) === -1) {
        engine._onLost.push(cb);
    }
}

/** Remove a previously-registered context-lost callback. */
export function offContextLost(engine: GLEngineContext, cb: () => void): void {
    const i = engine._onLost.indexOf(cb);
    if (i !== -1) {
        engine._onLost.splice(i, 1);
    }
}

/** Register a `webglcontextrestored` callback. Duplicate registrations are ignored. */
export function onContextRestored(engine: GLEngineContext, cb: () => void): void {
    if (engine._onRestored.indexOf(cb) === -1) {
        engine._onRestored.push(cb);
    }
}

/** Remove a previously-registered context-restored callback. */
export function offContextRestored(engine: GLEngineContext, cb: () => void): void {
    const i = engine._onRestored.indexOf(cb);
    if (i !== -1) {
        engine._onRestored.splice(i, 1);
    }
}

/* ─────────────────────────  internal: loss / restore  ───────────────────── */

function handleContextLost(engine: GLEngineContext, e: Event): void {
    // Opt-in to restore. Without preventDefault() the browser will NOT fire
    // webglcontextrestored later.
    e.preventDefault();
    if (engine._isLost || engine._disposed) {
        return;
    }
    engine._isLost = true;
    engine._wasLoopActive = engine._rafId !== 0;
    if (engine._rafId !== 0) {
        cancelAnimationFrame(engine._rafId);
        engine._rafId = 0;
    }
    resetGLState(engine._state);
    engine._currentRenderTarget = null;
    for (const eff of engine._effects) {
        eff.isReady = false;
        eff._samplersAssigned = false;
        eff.uniformLocations = {};
        eff.attributeLocations = {};
        // Clear value caches so the first frame after restore re-uploads
        // every uniform into the freshly-linked program.
        clearObject(eff._lastF1);
        clearObject(eff._lastVec);
        clearObject(eff._lastI1);
        // Do NOT gl.deleteProgram — handle is already dead per WebGL spec.
    }
    for (const tex of engine._textures) {
        tex._wasReady = tex.isReady;
        tex.isReady = false;
    }
    const cbs = engine._onLost.slice();
    for (const cb of cbs) {
        try {
            cb();
        } catch (err) {
            console.error("lite-gl: onLost callback threw", err);
        }
    }
}

function handleContextRestored(engine: GLEngineContext): void {
    if (engine._disposed) {
        return;
    }
    for (const eff of engine._effects) {
        if (!eff._disposed) {
            eff._restore(engine);
        }
    }
    for (const tex of engine._textures) {
        if (!tex._disposed) {
            const newHandle = engine.gl.createTexture();
            if (newHandle !== null) {
                tex.handle = newHandle;
                tex._upload(engine);
                tex.isReady = tex._wasReady;
            }
        }
    }
    // Clear the lost flag BEFORE the render-target / buffer rebuilds: their
    // `_restore` closures route through the same guarded build/upload paths used
    // at create time (which no-op while `_isLost`), whereas the effect / texture
    // replay above is unguarded and unaffected by the flag's value.
    engine._isLost = false;
    // Render targets rebuild their own color texture + FBO + renderbuffer AFTER
    // the standalone texture replay above (an RT's color texture is owned by the
    // RT, not the `_textures` registry).
    for (const rt of engine._renderTargets) {
        if (!rt._disposed) {
            rt._restore(engine);
        }
    }
    // Mesh buffers re-upload their retained CPU data into fresh GL buffers.
    for (const buf of engine._buffers) {
        if (!buf._disposed) {
            buf._restore(engine);
        }
    }
    if (engine._wasLoopActive && engine._loops.length > 0 && engine._scheduleFrame !== null) {
        engine._scheduleFrame(engine);
    }
    const cbs = engine._onRestored.slice();
    for (const cb of cbs) {
        try {
            cb();
        } catch (err) {
            console.error("lite-gl: onRestored callback threw", err);
        }
    }
}

function clearObject(o: { [k: string]: unknown }): void {
    for (const key in o) {
        delete o[key];
    }
}
