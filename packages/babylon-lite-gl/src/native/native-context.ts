/**
 * Native engine context — the native-backend twin of `context.ts`'s
 * `GLEngineContext`. Instead of a `WebGL2RenderingContext`, it owns a Babylon
 * Native engine (`_native.Engine`) plus a {@link CommandBufferEncoder} that all
 * native device ops (native-device.ts) write into.
 *
 * The public shape mirrors `GLEngineContext` field-for-field where it is
 * device-agnostic, so the parallel native higher-level modules (native/effect.ts,
 * native/sprites.ts, …) read/write the same `_state`, `_effects`, `_textures`,
 * `_isLost`/`_disposed` slots as their WebGL counterparts. Only the raw device
 * handle differs (`_engine` + `_encoder` here vs `gl` there).
 */
import type { GLEffect } from "./effect.js";
import type { GLTexture } from "./texture.js";
import type { GLRenderTarget } from "./render-target.js";
import type { GLPerfCounter } from "../gpu-frame-time.js";
import { createNativeGLState, resetNativeGLState, resetNativeGLStateCache, type NativeGLState } from "./native-state.js";
import { CommandBufferEncoder } from "./native-command-encoder.js";
import type { INativeEngine, NativeData } from "./native-types.js";
import { setDepthState, setCullState, setColorMask } from "./depth-stencil.js";
import { disableBlend } from "./blend.js";

/**
 * Minimal context-restorable native buffer, kept local so the public
 * `GLEngineContext` type carries no dependency on the tree-shakeable `mesh`
 * entry (mirrors `context.ts`'s `GLManagedBuffer`).
 * @internal
 */
export interface NativeManagedBuffer {
    /** The live native buffer handle. */
    handle: NativeData;
    /** @internal */
    _disposed: boolean;
    /** @internal */
    _deleteGpu: (engine: GLEngineContext) => void;
    /** @internal */
    _restore: (engine: GLEngineContext) => void;
}

/**
 * Per-frame begin / end hooks installed by opt-in modules (currently only
 * `captureGPUFrameTime`). Invoked by the render loop around its callbacks, or by
 * manual `beginFrame` / `endFrame` calls. Mirrors `context.ts`'s `GLFrameHooks`.
 * @internal
 */
export interface GLFrameHooks {
    /** @internal */
    _begin: () => void;
    /** @internal */
    _end: () => void;
    /** Releases any resources owned by the hooks. @internal */
    _dispose: () => void;
}

/**
 * Constructor options for {@link createGLEngine}. Same field names as the WebGL
 * `GLEngineOptions` so option objects are portable, but the Babylon Native host
 * owns the surface: every WebGL context attribute is accepted and IGNORED.
 * Only {@link GLEngineOptions.adaptToDeviceRatio} is honoured.
 */
export interface GLEngineOptions {
    /** Ignored on native (the host owns the surface). */
    alpha?: boolean;
    /** Ignored on native. */
    premultipliedAlpha?: boolean;
    /** Ignored on native (MSAA is configured by the host). */
    antialias?: boolean;
    /** Ignored on native. */
    preserveDrawingBuffer?: boolean;
    /** Ignored on native (the host owns the backbuffer depth). */
    depth?: boolean;
    /** Ignored on native (the host owns the backbuffer stencil). */
    stencil?: boolean;
    /** Ignored on native. */
    powerPreference?: "default" | "high-performance" | "low-power";
    /** Ignored on native. */
    failIfMajorPerformanceCaveat?: boolean;
    /** NATIVE-ONLY: set the hardware-scaling level to `1 / devicePixelRatio`
     *  (default: false). */
    adaptToDeviceRatio?: boolean;
}

/** Read-only capability limits — the WebGL `GLEngineCaps` fields plus native
 *  feature flags for the declared divergences of the Babylon Native backend.
 *  Float/half-float rendering is core on the native (bgfx) backend. */
export interface GLEngineCaps {
    /** Largest supported texture dimension, in texels. */
    readonly maxTextureSize: number;
    /** Number of sampler binding slots. */
    readonly maxTextureUnits: number;
    /** Kept for API parity with the WebGL caps; native drives async compile via
     *  `createProgramAsync` callbacks rather than a poll, so this is always null. */
    readonly parallelShaderCompile: null;
    /** Native (bgfx) renders float color attachments. */
    readonly textureFloatRender: boolean;
    /** Native supports float linear filtering. */
    readonly textureFloatLinearFiltering: boolean;
    /** Native renders half-float color attachments. */
    readonly textureHalfFloatRender: boolean;
    /** Native supports half-float linear filtering. */
    readonly textureHalfFloatLinearFiltering: boolean;
    /** NPOT textures are core on native. */
    readonly needPOTTextures: boolean;
    /** NATIVE-ONLY: 3D textures (`texture-3d`) — always `false` on Babylon Native. */
    readonly texture3D: boolean;
    /** NATIVE-ONLY: alpha-to-coverage — always `false` on Babylon Native. */
    readonly alphaToCoverage: boolean;
    /** NATIVE-ONLY: separate front/back stencil ops — always `false` on Babylon Native. */
    readonly separateStencil: boolean;
    /** NATIVE-ONLY: GPU frame timing — `true` when the host exposes `populateFrameStats`. */
    readonly gpuFrameTime: boolean;
    /** NATIVE-ONLY: the Slug GPU text renderer — always `false` on Babylon Native. */
    readonly textRendering: boolean;
}

/**
 * Transient dynamic-draw batch for the native mesh dynamic path
 * (`bindAttributes` → `drawIndexed`). Native has no default/null VAO, so that
 * path records into a throwaway vertex array retired after each draw. Kept local
 * so the context type carries no dependency on the tree-shakeable `mesh` entry;
 * mesh.ts's usage satisfies it structurally (mirrors {@link NativeManagedBuffer}).
 */
export interface NativeDynBatch {
    /** The current transient vertex array, or null before the first record. */
    vao: NativeData | null;
    /** The index buffer recorded into `vao`, or null. */
    ib: NativeData | null;
    /** True once a draw has consumed `vao` (triggers a rebuild). */
    drawn: boolean;
}

/**
 * Native context handle — the Babylon Native `GLEngineContext`. INVARIANT:
 * consumers MUST NOT record commands through `_engine`/`_encoder` directly —
 * native-device.ts owns every command, keeping `_state` in sync.
 */
export interface GLEngineContext {
    /** No HTML canvas backs a native device (the host owns the surface). Present
     *  and always `null` for parity with the WebGL `GLEngineContext.canvas`, so
     *  consumer code that reads `ctx.canvas` stays portable. */
    readonly canvas: null;
    /** The Babylon Native engine instance. Do NOT drive it directly. @internal */
    readonly _engine: INativeEngine;
    /** The command encoder every native device op writes into. @internal */
    readonly _encoder: CommandBufferEncoder;
    /** Queried capability limits + native feature flags. */
    readonly caps: GLEngineCaps;
    /** Hardware-scaling level. @internal */
    _hsl: number;
    /** True while a render loop is active (native uses `requestAnimationFrame`,
     *  which returns no id, so this is a boolean flag rather than a handle). @internal */
    _rafActive: boolean;
    /** Per-frame callbacks. @internal */
    _loops: ((dt: number) => void)[];
    /** Timestamp of last frame for delta computation. @internal */
    _prevNow: number;
    /** Cached device state. @internal */
    _state: NativeGLState;
    /** Live effect registry (context-restore rebuild). @internal */
    _effects: GLEffect[];
    /** Per-engine effect cache keyed by source descriptor. @internal */
    _effectCache: Map<string, GLEffect>;
    /** Live texture registry. @internal */
    _textures: GLTexture[];
    /** Live render-target registry. @internal */
    _renderTargets: GLRenderTarget[];
    /** The render target currently bound for drawing, or null for the backbuffer. @internal */
    _currentRenderTarget: GLRenderTarget | null;
    /** Live vertex/index buffer registry. @internal */
    _buffers: NativeManagedBuffer[];
    /** @internal */
    _onLost: (() => void)[];
    /** @internal */
    _onRestored: (() => void)[];
    /** True between a device-lost and its restore. @internal */
    _isLost: boolean;
    /** True once disposed. @internal */
    _disposed: boolean;
    /** True when a loop was active at device-lost, to resume on restore. @internal */
    _wasLoopActive: boolean;
    /** Installed by the native render loop; lets restore resume it. @internal */
    _scheduleFrame: ((engine: GLEngineContext) => void) | null;
    /** Transient dynamic-draw batch for the mesh dynamic path (native has no
     *  default/null VAO). Null until that path is first used. @internal */
    _dynBatch: NativeDynBatch | null;
    /** Module-owned state caches reset by {@link wipeGLStateCache}. @internal */
    _stateCacheInvalidators?: (() => void)[];
    /** Opt-in per-frame hooks (`captureGPUFrameTime`). @internal */
    _frameHooks?: GLFrameHooks;
    /** Lazily created GPU frame-time counter. @internal */
    _gpuFrameTime?: GLPerfCounter;
}

/** Build a native context around a freshly created Babylon Native engine.
 *  Requires the `_native` global (only present inside a Babylon Native host).
 *  @internal Public callers use {@link createGLEngine}. */
export function createNativeGLEngine(options?: GLEngineOptions): GLEngineContext {
    if (typeof _native === "undefined") {
        throw new Error("lite-gl: createGLEngine requires the Babylon Native `_native` global");
    }
    const o = options ?? {};
    // Mirror ThinNativeEngine._initializeNativeEngine: the version string is opaque
    // to lite-gl; the protocol handshake is enforced host-side.
    const engine = new _native.Engine({ version: "@babylonjs/lite-gl", nonFloatVertexBuffers: true });
    const encoder = new CommandBufferEncoder(engine);

    const caps: GLEngineCaps = {
        maxTextureSize: _native.Engine.CAPS_LIMITS_MAX_TEXTURE_SIZE,
        // Native does not expose a combined-sampler-unit limit constant; 16 matches
        // ThinNativeEngine's `maxTexturesImageUnits` default.
        maxTextureUnits: 16,
        parallelShaderCompile: null,
        textureFloatRender: true,
        textureFloatLinearFiltering: true,
        textureHalfFloatRender: true,
        textureHalfFloatLinearFiltering: true,
        needPOTTextures: false,
        texture3D: false,
        alphaToCoverage: false,
        separateStencil: false,
        gpuFrameTime: typeof engine.populateFrameStats === "function",
        textRendering: false,
    };

    const dpr =
        typeof globalThis !== "undefined" && (globalThis as { devicePixelRatio?: number }).devicePixelRatio ? (globalThis as { devicePixelRatio: number }).devicePixelRatio : 1;
    const hsl = o.adaptToDeviceRatio ? 1 / dpr : 1;
    engine.setHardwareScalingLevel(hsl);

    const context: GLEngineContext = {
        canvas: null,
        _engine: engine,
        _encoder: encoder,
        caps,
        _hsl: hsl,
        _rafActive: false,
        _loops: [],
        _prevNow: 0,
        _state: createNativeGLState(caps.maxTextureUnits),
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
        _wasLoopActive: false,
        _scheduleFrame: null,
        _dynBatch: null,
    };

    // Device-restore edge (bgfx re-init). Native has no separate "lost" event, so
    // we treat the reset as lost→restored: forget the state cache, then replay.
    const onReset = (): void => {
        handleNativeContextRestored(context);
    };
    if (engine.setRenderResetCallback) {
        engine.setRenderResetCallback(onReset);
    } else if (engine.setDeviceLostCallback) {
        engine.setDeviceLostCallback(onReset);
    }

    establishDefaultRenderState(context);

    return context;
}

/**
 * Seed the WebGL-equivalent default draw state. A fresh WebGL2 context defaults to
 * depth-test OFF, no cull, full RGBA color write and blend OFF — the state that
 * fullscreen-effect consumers rely on without setting it. Native/bgfx instead
 * defaults to `DEPTH_TEST_LESS` + back-face cull, which DISCARDS a fullscreen quad
 * whenever the depth buffer isn't cleared. Establishing these here (at creation
 * and after device-restore) keeps the native backend a drop-in for the WebGL one.
 * @internal
 */
function establishDefaultRenderState(engine: GLEngineContext): void {
    setDepthState(engine, { test: false, write: false });
    setCullState(engine, false);
    setColorMask(engine, true, true, true, true);
    disableBlend(engine);
}

/** Release every effect/texture/render-target/buffer and dispose the native
 *  engine. Idempotent. @internal Public callers use {@link disposeGLEngine}. */
export function disposeNativeGLEngine(engine: GLEngineContext): void {
    if (engine._disposed) {
        return;
    }
    engine._disposed = true;
    engine._rafActive = false;
    engine._loops.length = 0;
    engine._frameHooks?._dispose();
    engine._frameHooks = undefined;
    for (const effect of engine._effects.slice()) {
        effect._deleteGpu(engine);
    }
    for (const tex of engine._textures.slice()) {
        tex._deleteGpu(engine);
    }
    for (const rt of engine._renderTargets.slice()) {
        rt._deleteGpu(engine);
    }
    for (const buf of engine._buffers.slice()) {
        buf._deleteGpu(engine);
    }
    engine._effects.length = 0;
    engine._effectCache.clear();
    engine._textures.length = 0;
    engine._renderTargets.length = 0;
    engine._currentRenderTarget = null;
    engine._buffers.length = 0;
    engine._onLost.length = 0;
    engine._onRestored.length = 0;
    engine._stateCacheInvalidators?.splice(0);
    resetNativeGLState(engine._state);
    engine._engine.dispose();
}

/**
 * Create a lite-gl engine on the Babylon Native host (`_native.Engine`).
 *
 * NATIVE DIVERGENCE: the host owns the rendering surface, so `canvas` is
 * accepted for source-compatibility and IGNORED — pass `null` from native-only
 * code. The resulting context's `canvas` field is always `null`.
 *
 * @param canvas - Ignored on native (the host owns the surface).
 * @param options - See {@link GLEngineOptions}; only `adaptToDeviceRatio` is honoured.
 * @returns The native engine context.
 * @throws If the Babylon Native `_native` global is missing.
 */
export function createGLEngine(canvas: HTMLCanvasElement | OffscreenCanvas | null, options?: GLEngineOptions): GLEngineContext {
    void canvas;
    return createNativeGLEngine(options);
}

/**
 * Release every effect/texture/render-target/buffer, stop the render loop and
 * dispose the native engine. Idempotent.
 *
 * @param engine - The engine to dispose.
 */
export function disposeGLEngine(engine: GLEngineContext): void {
    disposeNativeGLEngine(engine);
}

/**
 * WebGL-compat no-op: the native drawing-buffer size is host-driven (bgfx), so a
 * CSS-derived resize request has nothing to do here.
 *
 * @param engine - The engine (unused).
 */
export function resizeGLEngine(engine: GLEngineContext): void {
    void engine;
}

/**
 * Request an explicit drawing-buffer size (the counterpart of Babylon's
 * `ThinEngine.setSize`).
 *
 * NATIVE: the backbuffer is owned and resized by the Babylon Native host
 * (`Graphics::Device::UpdateSize`); there is no JS-side resize API on
 * `_native.Engine`. This is therefore a documented no-op — size the host view
 * instead and read the effective size via {@link getRenderWidth} /
 * {@link getRenderHeight}. Never touches the viewport.
 *
 * @param engine - The engine.
 * @param width - Requested drawing-buffer width in physical pixels (ignored).
 * @param height - Requested drawing-buffer height in physical pixels (ignored).
 */
export function setGLEngineSize(engine: GLEngineContext, width: number, height: number): void {
    void engine;
    void width;
    void height;
}

/**
 * Invalidate lite-gl's cached device state so the next state-setting call in
 * each category (program / texture / VAO / framebuffer bindings, blend, depth,
 * stencil, scissor, color-mask, viewport) is re-issued instead of elided — the
 * counterpart of Babylon's `Engine.wipeCaches()`. Owned GPU resources (shared
 * quad, render targets, meshes, effects, textures) are preserved.
 *
 * No-op while the context is lost or the engine is disposed.
 *
 * @param engine - The engine.
 */
export function wipeGLStateCache(engine: GLEngineContext): void {
    if (engine._disposed || engine._isLost) {
        return;
    }
    resetNativeGLStateCache(engine._state);
    const invalidators = engine._stateCacheInvalidators;
    if (invalidators) {
        for (const invalidate of invalidators) {
            invalidate();
        }
    }
}

/** Current backbuffer width in physical pixels. */
export function getRenderWidth(engine: GLEngineContext): number {
    return engine._engine.getRenderWidth();
}

/** Current backbuffer height in physical pixels. */
export function getRenderHeight(engine: GLEngineContext): number {
    return engine._engine.getRenderHeight();
}

/** The hardware-scaling level (drawingBufferSize = cssSize / level). */
export function getHardwareScalingLevel(engine: GLEngineContext): number {
    return engine._hsl;
}

/** Set the hardware-scaling level. Ignores non-positive / non-finite levels
 *  (matching the WebGL backend). */
export function setHardwareScalingLevel(engine: GLEngineContext, level: number): void {
    if (level <= 0 || !isFinite(level)) {
        return;
    }
    engine._hsl = level;
    engine._engine.setHardwareScalingLevel(level);
}

/**
 * The backing canvas element.
 *
 * NATIVE DIVERGENCE: a Babylon Native host has no canvas (the host owns the
 * surface), so this always throws. Native code should use {@link getRenderWidth}
 * / {@link getRenderHeight} instead.
 *
 * @param engine - The engine.
 * @throws Always — `getRenderingCanvas is not supported on Babylon Native`.
 */
export function getRenderingCanvas(engine: GLEngineContext): HTMLCanvasElement | OffscreenCanvas {
    void engine;
    throw new Error("lite-gl: getRenderingCanvas is not supported on Babylon Native (the host owns the surface; engine.canvas is null)");
}

/** Register a device-lost callback. Duplicate registrations are ignored. */
export function onContextLost(engine: GLEngineContext, cb: () => void): void {
    if (engine._onLost.indexOf(cb) === -1) {
        engine._onLost.push(cb);
    }
}

/** Unregister a device-lost callback. */
export function offContextLost(engine: GLEngineContext, cb: () => void): void {
    const i = engine._onLost.indexOf(cb);
    if (i !== -1) {
        engine._onLost.splice(i, 1);
    }
}

/** Register a device-restored callback (fires AFTER the engine registries are
 *  rebuilt, so composite resources can read fresh handles). Duplicate
 *  registrations are ignored. */
export function onContextRestored(engine: GLEngineContext, cb: () => void): void {
    if (engine._onRestored.indexOf(cb) === -1) {
        engine._onRestored.push(cb);
    }
}

/** Unregister a device-restored callback. */
export function offContextRestored(engine: GLEngineContext, cb: () => void): void {
    const i = engine._onRestored.indexOf(cb);
    if (i !== -1) {
        engine._onRestored.splice(i, 1);
    }
}

/** Device-restore handler — forget the stale cache, then replay every registered
 *  resource and fire the composite-restore callbacks. @internal */
function handleNativeContextRestored(engine: GLEngineContext): void {
    if (engine._disposed) {
        return;
    }
    for (const cb of engine._onLost.slice()) {
        cb();
    }
    engine._isLost = false;
    resetNativeGLState(engine._state);
    establishDefaultRenderState(engine);
    engine._currentRenderTarget = null;
    for (const effect of engine._effects) {
        effect._restore(engine);
    }
    for (const tex of engine._textures) {
        tex._restore(engine);
    }
    for (const buf of engine._buffers) {
        buf._restore(engine);
    }
    for (const rt of engine._renderTargets) {
        rt._restore(engine);
    }
    for (const cb of engine._onRestored.slice()) {
        cb();
    }
    if (engine._wasLoopActive && engine._scheduleFrame !== null) {
        engine._rafActive = true;
        engine._scheduleFrame(engine);
    }
}
