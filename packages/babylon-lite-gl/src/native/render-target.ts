/**
 * Render-to-texture (offscreen framebuffer) support — the Babylon Native backend
 * of `src/render-target.ts`, with the same receiver-first API.
 *
 * A render target owns a color {@link GLTexture} (or attaches a caller-supplied
 * one) wrapped in a native framebuffer whose depth/stencil is baked in at
 * `createFrameBuffer` time. The default {@link createRenderTarget} makes an 8-bit
 * color target (RGBA8, or RG8 / R8 via `format`); {@link createFloatRenderTarget}
 * is the opt-in for float / half-float color attachments.
 *
 * The color + framebuffer GPU set is rebuilt on device restore: the render
 * target registers itself in the engine's `_renderTargets` registry, whose
 * `_restore` runs AFTER the standalone texture replay (so a BYO color texture
 * already has its fresh handle).
 *
 * NATIVE DIVERGENCES (documented per function):
 * 1. Depth/stencil is baked into the framebuffer; `generateRenderTargetStencil`
 *    rebuilds the framebuffer with a packed D24S8 attachment.
 * 2. No completeness check — `createFrameBuffer` succeeds or the host throws.
 * 3. Readbacks are ASYNCHRONOUS (`Promise`). Hosts with `readTexture2` read
 *    float / half-float targets at full float precision; older hosts read RGBA8
 *    (8-bit precision, clamped to [0, 1]) converted to the WebGL element type.
 * 4. `generateRenderTargetMipMaps` needs a host with `COMMAND_GENERATEMIPMAPS`
 *    (the first call re-allocates the owned color texture with a mip chain); it
 *    is a no-op on older hosts and for a caller-supplied color texture.
 * 5. `readRenderTargetPixelsToBuffer` writes into a CPU `ArrayBuffer` /
 *    `ArrayBufferView` (Native has no pixel-pack buffers).
 */
import type { GLTexture } from "./texture.js";
import { finishTextureUpload, makeTexture, replaceTextureHandle } from "./texture.js";
import type { GLEngineContext } from "./native-context.js";
import type { NativeFramebuffer, NativeTexture } from "./native-types.js";
import type { GLReadPixelsOptions, GLReadPixelsRegionOptions, GLReadPixelsToBufferOptions } from "../render-target.js";
import {
    dBindFramebuffer,
    dCopyTexture,
    dCreateFramebuffer,
    dCreateTexture,
    dDeleteFramebuffer,
    dDeleteTexture,
    dGenerateMipMaps,
    dInitializeTexture,
    dReadTexture,
    dSetTextureSampling,
    dSetScissor,
    dSetTextureWrap,
    dSetViewport,
    dUnbindFramebuffer,
} from "./native-device.js";

export type { GLReadPixelsRegionOptions, GLReadPixelsOptions, GLReadPixelsToBufferOptions } from "../render-target.js";

/** GL `gl.UNSIGNED_BYTE`. */
const UNSIGNED_BYTE = 0x1401;
/** GL `gl.HALF_FLOAT`. */
const HALF_FLOAT = 0x140b;
/** GL `gl.FLOAT`. */
const FLOAT = 0x1406;
/** GL `gl.RGBA`. */
const RGBA = 0x1908;
/** GL `gl.RED`. */
const RED = 0x1903;
/** GL `gl.RG`. */
const RG = 0x8227;

/** Options for {@link createRenderTarget} — same fields as the WebGL
 *  `GLRenderTargetOptions` (with the native {@link GLTexture}). Every field has a
 *  Babylon-matching default: the bare `createRenderTarget(engine, width, height)`
 *  makes an RGBA8 color-only target with linear filtering and clamp wrapping. */
export interface GLRenderTargetOptions {
    /** Bake a depth buffer (D32; D24S8 on Android) into the framebuffer. Default
     *  `false`. Add stencil via `generateRenderTargetStencil`. */
    generateDepthBuffer?: boolean;
    /** 8-bit color attachment format: `gl.RGBA` (default, `RGBA8`), `gl.RG`
     *  (`RG8`) or `gl.RED` (`R8`). Ignored when {@link colorTexture} is supplied. */
    format?: GLenum;
    /** Color texture minification filter. Default `gl.LINEAR`. */
    minFilter?: GLenum;
    /** Color texture magnification filter. Default `gl.LINEAR`. */
    magFilter?: GLenum;
    /** Color texture S wrap. Default `gl.CLAMP_TO_EDGE`. */
    wrapS?: GLenum;
    /** Color texture T wrap. Default `gl.CLAMP_TO_EDGE`. */
    wrapT?: GLenum;
    /** Attach a caller-supplied (BYO) color {@link GLTexture} instead of creating
     *  one. The render target does NOT own, resize-allocate or dispose it unless
     *  it is a raw texture (resized through its raw-update hook); the caller sizes
     *  it to `width`×`height`. */
    colorTexture?: GLTexture;
}

/** Options for {@link createFloatRenderTarget} — {@link GLRenderTargetOptions}
 *  (always RGBA, so without `format`) plus the float color `type`. */
export interface GLFloatRenderTargetOptions extends Omit<GLRenderTargetOptions, "format"> {
    /** Float color attachment type. Default `gl.HALF_FLOAT`; pass `gl.FLOAT` for
     *  32-bit. Downgraded to the best renderable type the engine supports. */
    type?: GLenum;
}

/** Resolved attachment description, retained for resize / device restore. */
interface ResolvedRTConfig {
    /** Native color format (`TEXTURE_FORMAT_*`). */
    nativeFormat: number;
    /** WebGL color format (RGBA / RG / RED) — channel count of the attachment. */
    format: number;
    /** WebGL color type — selects the readback element type. */
    type: number;
    /** Bake a depth buffer into the framebuffer. */
    hasDepth: boolean;
    /** Bake a stencil buffer (set by `generateRenderTargetStencil`). */
    hasStencil: boolean;
    /** True when the RT owns (creates / restores / deletes) its color texture. */
    ownsColorTexture: boolean;
    /** True once the owned color texture carries a mip chain (set by the first
     *  `generateRenderTargetMipMaps`; kept across resize / restore). */
    hasMips: boolean;
}

/**
 * An offscreen render target — a native framebuffer wrapping a color
 * {@link GLTexture} with baked-in depth/stencil. Same public shape as the WebGL
 * `GLRenderTarget`.
 */
export interface GLRenderTarget {
    /** The color attachment, sampleable like any other {@link GLTexture}. Its
     *  handle is swapped on device restore while consumers keep this reference. */
    texture: GLTexture;
    /** Color attachment width in texels. */
    width: number;
    /** Color attachment height in texels. */
    height: number;
    /** True once the color attachment + framebuffer are allocated. */
    isReady: boolean;
    /** @internal The native framebuffer (null until allocated). Swapped on restore / resize. */
    _framebuffer: NativeFramebuffer | null;
    /** @internal Resolved attachment config. */
    _config: ResolvedRTConfig;
    /** The engine that created (and owns) this render target. @internal */
    _engine: GLEngineContext;
    /** @internal */
    _disposed: boolean;
    /** @internal Delete the framebuffer and (iff owned) the color texture. */
    _deleteGpu: (engine: GLEngineContext) => void;
    /** @internal Rebuild the GPU set after device restore. */
    _restore: (engine: GLEngineContext) => void;
}

/**
 * Create an offscreen 8-bit render target — **RGBA8** by default, or `R8` /
 * `RG8` via {@link GLRenderTargetOptions.format}.
 *
 * @param engine - The engine to allocate native resources on.
 * @param width - Color attachment width in texels. Must be a positive integer.
 * @param height - Color attachment height in texels. Must be a positive integer.
 * @param options - See {@link GLRenderTargetOptions}.
 * @returns The new {@link GLRenderTarget}.
 * @throws If `format` is not `RGBA` / `RG` / `RED` or the size is invalid.
 */
export function createRenderTarget(engine: GLEngineContext, width: number, height: number, options?: GLRenderTargetOptions): GLRenderTarget {
    const opts = options ?? {};
    const format = opts.format ?? RGBA;
    let nativeFormat: number;
    if (format === RGBA) {
        nativeFormat = _native.Engine.TEXTURE_FORMAT_RGBA8;
    } else if (format === RG) {
        nativeFormat = _native.Engine.TEXTURE_FORMAT_RG8;
    } else if (format === RED) {
        nativeFormat = _native.Engine.TEXTURE_FORMAT_R8;
    } else {
        throw new Error(`lite-gl: unsupported render target format 0x${format.toString(16)}`);
    }
    return buildRT(engine, width, height, opts, nativeFormat, format, UNSIGNED_BYTE);
}

/**
 * Create an offscreen **float / half-float** RGBA render target.
 *
 * Defaults to `gl.HALF_FLOAT`; pass `options.type = gl.FLOAT` for 32-bit. The
 * type is downgraded to the best renderable type the engine supports.
 *
 * @param engine - The engine to allocate native resources on.
 * @param width - Color attachment width in texels. Must be a positive integer.
 * @param height - Color attachment height in texels. Must be a positive integer.
 * @param options - See {@link GLFloatRenderTargetOptions}.
 * @returns The new {@link GLRenderTarget}.
 * @throws As {@link createRenderTarget}.
 */
export function createFloatRenderTarget(engine: GLEngineContext, width: number, height: number, options?: GLFloatRenderTargetOptions): GLRenderTarget {
    const opts = options ?? {};
    const type = resolveColorType(engine, opts.type ?? HALF_FLOAT);
    const nativeFormat = type === FLOAT ? _native.Engine.TEXTURE_FORMAT_RGBA32F : type === HALF_FLOAT ? _native.Engine.TEXTURE_FORMAT_RGBA16F : _native.Engine.TEXTURE_FORMAT_RGBA8;
    return buildRT(engine, width, height, opts, nativeFormat, RGBA, type);
}

/**
 * Bind the render target's framebuffer as the draw target and set the viewport
 * to cover it. Use {@link restoreDefaultFramebuffer} to return to the
 * backbuffer. Cached; no-op on a lost/disposed engine or a disposed `rt`.
 *
 * @param rt - The render target to draw into.
 */
export function bindRenderTarget(rt: GLRenderTarget): void {
    const engine = rt._engine;
    if (engine._isLost || engine._disposed || rt._disposed || rt._framebuffer === null) {
        return;
    }
    bindFramebufferAndViewport(engine, rt, rt._framebuffer);
}

/**
 * Bind the backbuffer and reset the viewport to cover it — the counterpart of
 * Babylon's `restoreDefaultFramebuffer`. Cached; no-op on a lost/disposed engine.
 *
 * @param engine - The engine.
 */
export function restoreDefaultFramebuffer(engine: GLEngineContext): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    bindFramebufferAndViewport(engine, null, null);
}

/** Bind `fb` (native has no "bind 0": unbind the previous target first — as
 *  `ThinNativeEngine.bindFramebuffer`) and set a full-target viewport. The host
 *  keeps one viewport PER framebuffer, so a framebuffer switch always re-issues
 *  it. Viewports are normalized (0–1) relative to the bound framebuffer. */
function bindFramebufferAndViewport(engine: GLEngineContext, rt: GLRenderTarget | null, fb: NativeFramebuffer | null): void {
    const s = engine._state;
    if (s.boundFramebuffer !== fb) {
        if (s.boundFramebuffer !== null) {
            dUnbindFramebuffer(engine, s.boundFramebuffer);
        }
        if (fb !== null) {
            dBindFramebuffer(engine, fb);
        }
        s.boundFramebuffer = fb;
        s.viewportW = -1;
        // The host also keeps the scissor PER framebuffer, while WebGL's is
        // global: carry the current scissor over to the newly bound target.
        if (s.scissorEnabled === 1) {
            dSetScissor(engine, s.scissorX, s.scissorY, s.scissorW, s.scissorH);
        } else if (s.scissorEnabled === 0) {
            dSetScissor(engine, 0, 0, 0, 0);
        }
    }
    engine._currentRenderTarget = rt;
    if (s.viewportX !== 0 || s.viewportY !== 0 || s.viewportW !== 1 || s.viewportH !== 1) {
        s.viewportX = 0;
        s.viewportY = 0;
        s.viewportW = 1;
        s.viewportH = 1;
        dSetViewport(engine, 0, 0, 1, 1);
    }
}

/**
 * Regenerate a render target's color mip chain from its (freshly rendered)
 * level 0 (≙ WebGL `generateRenderTargetMipMaps`) — a manual opt-in, called
 * after rendering into the target.
 *
 * NATIVE: render-target textures are allocated without a mip chain, so the
 * first call re-allocates the owned color texture with one (copying level 0,
 * keeping the {@link GLTexture} identity) before `COMMAND_GENERATEMIPMAPS`. A
 * documented **no-op** on hosts without that command and for a caller-supplied
 * color texture. Also a no-op for a disposed target or a lost/disposed engine.
 *
 * @param rt - The render target.
 */
export function generateRenderTargetMipMaps(rt: GLRenderTarget): void {
    const engine = rt._engine;
    const c = rt._config;
    if (engine._isLost || engine._disposed || rt._disposed || rt._framebuffer === null || !c.ownsColorTexture || _native.Engine.COMMAND_GENERATEMIPMAPS === undefined) {
        return;
    }
    if (!c.hasMips) {
        const tex = rt.texture;
        const handle = dCreateTexture(engine);
        dInitializeTexture(engine, handle, rt.width, rt.height, true, c.nativeFormat, true);
        dCopyTexture(engine, tex.handle, handle);
        c.hasMips = true;
        // Drop the framebuffer before its attachment, then rebuild it around the
        // mip-capable texture (rebinding it if it was the live target).
        const s = engine._state;
        const wasBound = s.boundFramebuffer === rt._framebuffer;
        if (wasBound) {
            dUnbindFramebuffer(engine, rt._framebuffer);
            s.boundFramebuffer = null;
        }
        dDeleteFramebuffer(engine, rt._framebuffer);
        replaceTextureHandle(engine, tex, handle);
        finishTextureUpload(engine, tex);
        rt._framebuffer = dCreateFramebuffer(engine, handle, rt.width, rt.height, c.hasStencil, c.hasDepth || c.hasStencil);
        if (wasBound) {
            bindRenderTarget(rt);
        }
    }
    dGenerateMipMaps(engine, rt.texture.handle);
}

/**
 * Resize the render target's color attachment (and depth/stencil). Contents are
 * discarded; the {@link GLRenderTarget} / {@link GLTexture} identity is kept. If
 * this target was the live draw target it is rebound afterwards. No-op when the
 * size is unchanged or `rt` is disposed; deferred to restore while lost.
 *
 * A BYO raw color texture is re-specified through its raw-update hook; any other
 * BYO texture must be resized by its owner (the framebuffer is rebuilt around it).
 *
 * @param rt - The render target to resize.
 * @param width - New width in texels (≥ 1).
 * @param height - New height in texels (≥ 1).
 */
export function resizeRenderTarget(rt: GLRenderTarget, width: number, height: number): void {
    const engine = rt._engine;
    if (rt._disposed) {
        return;
    }
    validateSize(width, height);
    if (rt.width === width && rt.height === height) {
        return;
    }
    rt.width = width;
    rt.height = height;
    if (rt._config.ownsColorTexture) {
        rt.texture.width = width;
        rt.texture.height = height;
    }
    if (engine._isLost || engine._disposed) {
        return;
    }
    const wasBound = rt._framebuffer !== null && engine._state.boundFramebuffer === rt._framebuffer;
    if (!rt._config.ownsColorTexture) {
        rt.texture._updateRaw?.(engine, null, width, height, 4);
    }
    rt._deleteGpu(engine);
    allocateRenderTargetGpu(engine, rt);
    if (wasBound) {
        bindRenderTarget(rt);
    }
}

/**
 * Read back a rectangle of the render target's color attachment.
 *
 * NATIVE DIVERGENCE — **ASYNCHRONOUS**: Babylon Native has no synchronous
 * readback, so this resolves a `Promise` (≙ `ThinNativeEngine._readTexturePixels`).
 * Pending draw commands are submitted first so the read sees them. Float /
 * half-float targets keep full precision on hosts with `readTexture2`; older
 * hosts read RGBA8, so they resolve with 8-bit precision clamped to [0, 1]
 * (converted to `Float32Array` / half-float `Uint16Array`). `format`
 * `gl.RG` / `gl.RED` pack 2 / 1 channels per texel tightly. Current hosts
 * return rows bottom-up with `y` measured from the bottom, as WebGL; older
 * hosts follow the texture memory layout instead.
 *
 * @param rt - The render target to read from.
 * @param options - See {@link GLReadPixelsOptions}. Default: the whole target,
 *  as RGBA, into a fresh buffer.
 * @returns A promise for the pixel buffer (`into`, or a fresh one). Resolves with
 *  an empty / untouched buffer on a lost/disposed engine or target.
 */
export async function readRenderTargetPixels(rt: GLRenderTarget, options?: GLReadPixelsOptions): Promise<ArrayBufferView> {
    const opts = options ?? {};
    const width = opts.width ?? rt.width;
    const height = opts.height ?? rt.height;
    const channels = channelCount(opts.format ?? RGBA);
    const type = rt._config.type;
    const into = opts.into;
    const rgba = await readRgba(rt, opts, width, height);
    if (rgba === null) {
        return into ?? new Uint8Array(0);
    }
    const elements = width * height * channels;
    const out = into ?? (type === FLOAT ? new Float32Array(elements) : type === HALF_FLOAT ? new Uint16Array(elements) : new Uint8Array(elements));
    writeTexels(rgba, out, 0, channels, type, width * height);
    return out;
}

/**
 * Read a rectangle of the render target's color attachment into a caller
 * buffer at a byte offset (≙ WebGL `readRenderTargetPixelsToBuffer`).
 *
 * NATIVE DIVERGENCE: Native has no pixel-pack (`WebGLBuffer`) readback, so
 * `buffer` must be a CPU `ArrayBuffer` or `ArrayBufferView` (whose `byteOffset`
 * is honoured), the copy is ASYNCHRONOUS (the returned promise resolves once the
 * bytes are written) and texels are stored in the target's type with the same
 * precision caveat as {@link readRenderTargetPixels}. A `WebGLBuffer`
 * throws.
 *
 * @param rt - The render target to read from.
 * @param buffer - Destination `ArrayBuffer` / `ArrayBufferView`.
 * @param options - See {@link GLReadPixelsToBufferOptions}; `offset` is in bytes
 *  and must be a multiple of the texel type's size.
 * @returns A promise resolved once the destination is written (immediately on a
 *  lost/disposed engine or target, which skips the read).
 * @throws If `buffer` is not CPU memory, `offset` is misaligned, or the
 *  destination is too small.
 */
export async function readRenderTargetPixelsToBuffer(
    rt: GLRenderTarget,
    buffer: WebGLBuffer | ArrayBuffer | ArrayBufferView,
    options?: GLReadPixelsToBufferOptions
): Promise<void> {
    const opts = options ?? {};
    let target: ArrayBuffer;
    let base = 0;
    if (buffer instanceof ArrayBuffer) {
        target = buffer;
    } else if (ArrayBuffer.isView(buffer)) {
        target = buffer.buffer as ArrayBuffer;
        base = buffer.byteOffset;
    } else {
        throw new Error("lite-gl: readRenderTargetPixelsToBuffer on Babylon Native needs an ArrayBuffer / ArrayBufferView destination (WebGLBuffer is not supported)");
    }
    const width = opts.width ?? rt.width;
    const height = opts.height ?? rt.height;
    const channels = channelCount(opts.format ?? RGBA);
    const type = rt._config.type;
    const bytesPerChannel = type === FLOAT ? 4 : type === HALF_FLOAT ? 2 : 1;
    const offset = opts.offset ?? 0;
    if (offset < 0 || offset % bytesPerChannel !== 0) {
        throw new Error(`lite-gl: readRenderTargetPixelsToBuffer offset must be a non-negative multiple of ${bytesPerChannel}`);
    }
    const elements = width * height * channels;
    const start = base + offset;
    if (start + elements * bytesPerChannel > target.byteLength) {
        throw new Error("lite-gl: readRenderTargetPixelsToBuffer destination is too small");
    }
    const rgba = await readRgba(rt, opts, width, height);
    if (rgba === null) {
        return;
    }
    const out =
        type === FLOAT ? new Float32Array(target, start, elements) : type === HALF_FLOAT ? new Uint16Array(target, start, elements) : new Uint8Array(target, start, elements);
    writeTexels(rgba, out, 0, channels, type, width * height);
}

/**
 * Release the render target's framebuffer and (iff owned) color texture, and
 * unregister it. Idempotent; no-op for `null` / `undefined`. A BYO color texture
 * is NOT disposed.
 *
 * @param rt - The render target to dispose, or `null` / `undefined`.
 */
export function disposeRenderTarget(rt: GLRenderTarget | null | undefined): void {
    if (rt === null || rt === undefined || rt._disposed) {
        return;
    }
    const engine = rt._engine;
    rt._disposed = true;
    if (rt._config.ownsColorTexture) {
        rt.texture._disposed = true;
    }
    if (engine._currentRenderTarget === rt) {
        engine._currentRenderTarget = null;
    }
    const i = engine._renderTargets.indexOf(rt);
    if (i !== -1) {
        engine._renderTargets.splice(i, 1);
    }
    const handle = rt.texture.handle;
    if (!engine._isLost && !engine._disposed) {
        if (rt._config.ownsColorTexture) {
            const bound = engine._state.boundTextures;
            for (let u = 0; u < bound.length; u++) {
                if (bound[u] === handle) {
                    bound[u] = null;
                }
            }
        }
        rt._deleteGpu(engine);
    } else {
        rt.isReady = false;
    }
}

/**
 * Rebuild the framebuffer around the current color texture (keeping its
 * contents) — used by `generateRenderTargetStencil` after changing the baked
 * depth/stencil flags. Rebinds the target if it was bound.
 * @internal
 */
export function rebuildRenderTargetFramebuffer(rt: GLRenderTarget): void {
    const engine = rt._engine;
    if (engine._isLost || engine._disposed || rt._disposed || rt._framebuffer === null) {
        return;
    }
    const s = engine._state;
    const wasBound = s.boundFramebuffer === rt._framebuffer;
    if (wasBound) {
        dUnbindFramebuffer(engine, rt._framebuffer);
        s.boundFramebuffer = null;
    }
    dDeleteFramebuffer(engine, rt._framebuffer);
    const c = rt._config;
    rt._framebuffer = dCreateFramebuffer(engine, rt.texture.handle, rt.width, rt.height, c.hasStencil, c.hasDepth || c.hasStencil);
    if (wasBound) {
        bindRenderTarget(rt);
    }
}

/* ────────────────────────────  internal helpers  ──────────────────────────── */

function buildRT(engine: GLEngineContext, width: number, height: number, options: GLFloatRenderTargetOptions, nativeFormat: number, format: number, type: number): GLRenderTarget {
    validateSize(width, height);
    const byo = options.colorTexture;
    const config: ResolvedRTConfig = {
        nativeFormat,
        format,
        type,
        hasDepth: options.generateDepthBuffer ?? false,
        hasStencil: false,
        ownsColorTexture: byo === undefined,
        hasMips: false,
    };
    // Owned attachment: allocated / restored / deleted by this target, never by
    // the engine texture registry. No mip chain until generateRenderTargetMipMaps.
    const texture = byo ?? makeTexture(engine, null as unknown as NativeTexture, width, height, false, options);
    if (byo === undefined) {
        texture._deleteGpu = () => {};
    }

    const rt: GLRenderTarget = {
        texture,
        width,
        height,
        isReady: false,
        _framebuffer: null,
        _config: config,
        _engine: engine,
        _disposed: false,
        _deleteGpu: () => {},
        _restore: () => {},
    };

    rt._deleteGpu = (target: GLEngineContext): void => {
        const s = target._state;
        if (rt._framebuffer !== null) {
            if (s.boundFramebuffer === rt._framebuffer) {
                dUnbindFramebuffer(target, rt._framebuffer);
                s.boundFramebuffer = null;
            }
            dDeleteFramebuffer(target, rt._framebuffer);
            rt._framebuffer = null;
        }
        if (config.ownsColorTexture && rt.texture.handle !== null) {
            dDeleteTexture(target, rt.texture.handle);
            rt.texture.handle = null as unknown as NativeTexture;
            rt.texture.isReady = false;
        }
        rt.isReady = false;
    };

    rt._restore = (target: GLEngineContext): void => {
        // Device restore invalidated every handle: forget them, then rebuild.
        rt._framebuffer = null;
        if (config.ownsColorTexture) {
            rt.texture.handle = null as unknown as NativeTexture;
        }
        try {
            allocateRenderTargetGpu(target, rt);
        } catch (err) {
            console.error("lite-gl: render target restore failed", err);
        }
    };

    allocateRenderTargetGpu(engine, rt);
    engine._renderTargets.push(rt);
    return rt;
}

function resolveColorType(engine: GLEngineContext, type: number): number {
    if (type === FLOAT && !engine.caps.textureFloatRender) {
        return engine.caps.textureHalfFloatRender ? HALF_FLOAT : UNSIGNED_BYTE;
    }
    if (type === HALF_FLOAT && !engine.caps.textureHalfFloatRender) {
        return UNSIGNED_BYTE;
    }
    return type;
}

function validateSize(width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new Error(`lite-gl: render target size must be positive integers, got ${width}x${height}`);
    }
}

/** (Re)allocate the owned color texture and the framebuffer. No-op while lost. */
function allocateRenderTargetGpu(engine: GLEngineContext, rt: GLRenderTarget): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const c = rt._config;
    if (c.ownsColorTexture) {
        const tex = rt.texture;
        const handle = dCreateTexture(engine);
        tex.handle = handle;
        dInitializeTexture(engine, handle, rt.width, rt.height, c.hasMips, c.nativeFormat, true);
        dSetTextureSampling(engine, handle, tex._filter);
        dSetTextureWrap(engine, handle, tex._wrapU, tex._wrapV, tex._wrapU);
        tex.width = rt.width;
        tex.height = rt.height;
        tex.isReady = true;
    }
    // Stencil without depth is packed into D24S8 by the host anyway; request
    // depth with it to avoid the host's "assuming depth and stencil" warning.
    rt._framebuffer = dCreateFramebuffer(engine, rt.texture.handle, rt.width, rt.height, c.hasStencil, c.hasDepth || c.hasStencil);
    rt.isReady = true;
}

function channelCount(format: number): number {
    if (format === RGBA) {
        return 4;
    }
    if (format === RG) {
        return 2;
    }
    if (format === RED) {
        return 1;
    }
    throw new Error(`lite-gl: unsupported read format 0x${format.toString(16)}`);
}

/** Submit pending commands and read the region as RGBA texels — `Float32Array`
 *  when the host preserved a float source (`readTexture2` → RGBA32F), else RGBA8
 *  bytes; `null` when the engine / target cannot be read. */
async function readRgba(rt: GLRenderTarget, region: GLReadPixelsRegionOptions, width: number, height: number): Promise<Uint8Array | Float32Array | null> {
    const engine = rt._engine;
    if (engine._isLost || engine._disposed || rt._disposed || rt._framebuffer === null) {
        return null;
    }
    engine._encoder.submitPending();
    const raw = await dReadTexture(engine, rt.texture.handle, 0, region.x ?? 0, region.y ?? 0, width, height, null, 0, 0);
    return raw.byteLength === width * height * 16 ? new Float32Array(raw) : new Uint8Array(raw);
}

/** Write `count` RGBA texels (RGBA8 bytes or RGBA32F floats) into `out` as
 *  `channels` channels of `type`. Float → byte clamps to [0, 1] and rounds. */
function writeTexels(src: Uint8Array | Float32Array, out: ArrayBufferView, start: number, channels: number, type: number, count: number): void {
    const isFloat = src instanceof Float32Array;
    if (type === FLOAT || type === HALF_FLOAT) {
        const half = type === HALF_FLOAT;
        const dst = out as Float32Array | Uint16Array;
        for (let i = 0, o = start; i < count; i++) {
            for (let c = 0; c < channels; c++) {
                const v = isFloat ? src[i * 4 + c]! : src[i * 4 + c]! / 255;
                dst[o++] = half ? floatToHalf(v) : v;
            }
        }
        return;
    }
    const dst = out instanceof Uint8Array ? out : new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    if (!isFloat && channels === 4) {
        dst.set(src.subarray(0, count * 4), start);
        return;
    }
    for (let i = 0, o = start; i < count; i++) {
        for (let c = 0; c < channels; c++) {
            const v = src[i * 4 + c]!;
            dst[o++] = isFloat ? Math.round(Math.min(Math.max(v, 0), 1) * 255) : v;
        }
    }
}

const f32Scratch = new Float32Array(1);
const u32Scratch = new Uint32Array(f32Scratch.buffer);

/** IEEE half-float bits for `v` (round to nearest even; ±Inf / NaN preserved). */
function floatToHalf(v: number): number {
    f32Scratch[0] = v;
    const x = u32Scratch[0]!;
    const sign = (x >>> 16) & 0x8000;
    const exp = (x >>> 23) & 0xff;
    let mant = x & 0x7fffff;
    if (exp === 0xff) {
        return sign | 0x7c00 | (mant !== 0 ? 0x200 : 0);
    }
    const e = exp - 112;
    if (e >= 0x1f) {
        return sign | 0x7c00;
    }
    if (e <= 0) {
        // Subnormal half (or zero).
        if (e < -10) {
            return sign;
        }
        mant |= 0x800000;
        const shift = 14 - e;
        const rem = mant & ((1 << shift) - 1);
        const halfway = 1 << (shift - 1);
        let h = mant >>> shift;
        if (rem > halfway || (rem === halfway && (h & 1) !== 0)) {
            h++;
        }
        return sign | h;
    }
    let h = (e << 10) | (mant >>> 13);
    const rem = mant & 0x1fff;
    // A carry out of the mantissa correctly bumps the exponent (up to Inf).
    if (rem > 0x1000 || (rem === 0x1000 && (h & 1) !== 0)) {
        h++;
    }
    return sign | h;
}
