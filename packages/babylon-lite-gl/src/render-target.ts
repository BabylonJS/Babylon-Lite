/**
 * Sub-entry: render-to-texture (offscreen framebuffer) support.
 *
 * Dynamic-importable via `import { ... } from "@babylonjs/lite-gl/render-target"`
 * so consumers that only render fullscreen effects to the canvas don't pull the
 * FBO code into their bundles.
 *
 * This is the lite-gl equivalent of Babylon's `RenderTargetWrapper` +
 * `ThinEngine.createRenderTargetTexture` / `bindFramebuffer` /
 * `restoreDefaultFramebuffer` / `_readTexturePixelsSync`. A render target owns a
 * color {@link GLTexture} (or attaches a caller-supplied one) plus an optional
 * depth and/or stencil renderbuffer, all wrapped in a single
 * `WebGLFramebuffer`.
 *
 * The default {@link createRenderTarget} makes an **RGBA8** color target and
 * ships none of the HDR sized-format knowledge; {@link createFloatRenderTarget}
 * is the separate opt-in for float / half-float color attachments (it alone
 * carries the `RGBA16F` / `RGBA32F` table, so RGBA8 consumers tree-shake it
 * away).
 *
 * The full color/depth/stencil GPU set is rebuilt automatically on
 * `webglcontextrestored` — the render target registers itself with the engine's
 * `_renderTargets` registry, and the context-restore protocol calls its
 * `_restore` closure AFTER the standalone texture replay. A caller-supplied
 * (BYO) color texture lives in the engine's `_textures` registry and is restored
 * there first; the RT then re-attaches its freshly-swapped handle.
 */
import { bindTextureForUpload, pickSizedInternalFormat, type GLTexture } from "./texture.js";
import type { GLEngineContext } from "./context.js";

/** GL `gl.UNSIGNED_BYTE` — the default (RGBA8) color attachment type. */
const UNSIGNED_BYTE = 0x1401;
/** GL `gl.HALF_FLOAT`. */
const HALF_FLOAT = 0x140b;
/** GL `gl.FLOAT`. */
const FLOAT = 0x1406;
/** GL `gl.RGBA`. */
const RGBA = 0x1908;
/** GL `gl.RGBA8` — the default sized internalFormat. */
const RGBA8 = 0x8058;
/** GL `gl.LINEAR`. */
const LINEAR = 0x2601;
/** GL `gl.CLAMP_TO_EDGE`. */
const CLAMP_TO_EDGE = 0x812f;

/** Options for {@link createRenderTarget}. `width`/`height` are required; every
 *  other field has a Babylon-matching default. The bare
 *  `createRenderTarget(engine, { width, height })` makes an RGBA8 color-only
 *  target with linear filtering and clamp wrapping. */
export interface GLRenderTargetOptions {
    /** Color attachment width in texels. Must be a positive integer. */
    width: number;
    /** Color attachment height in texels. Must be a positive integer. */
    height: number;
    /** Allocate a depth renderbuffer (`DEPTH_COMPONENT16`). Default `false`.
     *  Stencil is NOT a create option — opt in (packed depth+stencil, or
     *  stencil-only) via `generateRenderTargetStencil`
     *  (`@babylonjs/lite-gl/depth-stencil`), which keeps the stencil/packed
     *  renderbuffer code out of the render-target core bundle. */
    generateDepthBuffer?: boolean;
    /** Color texture minification filter. Default `gl.LINEAR`. */
    minFilter?: GLenum;
    /** Color texture magnification filter. Default `gl.LINEAR`. */
    magFilter?: GLenum;
    /** Color texture S wrap. Default `gl.CLAMP_TO_EDGE`. */
    wrapS?: GLenum;
    /** Color texture T wrap. Default `gl.CLAMP_TO_EDGE`. */
    wrapT?: GLenum;
    /** Attach a caller-supplied (BYO) color {@link GLTexture} instead of creating
     *  one. When supplied the render target does NOT own or restore it — the
     *  texture is engine-managed (restored by the standard texture-restore path
     *  first) and the RT re-attaches its swapped handle afterwards. The caller is
     *  responsible for sizing it to `width`×`height` and for disposing it. */
    colorTexture?: GLTexture;
}

/** Options for {@link createFloatRenderTarget} — {@link GLRenderTargetOptions}
 *  plus the float color `type`. */
export interface GLFloatRenderTargetOptions extends GLRenderTargetOptions {
    /** Float color attachment type. Default `gl.HALF_FLOAT`. Pass `gl.FLOAT` for
     *  full 32-bit. Downgraded to the best renderable type the engine supports
     *  (`caps.textureFloatRender` / `caps.textureHalfFloatRender`), mirroring
     *  Babylon's `getTextureType`. */
    type?: GLenum;
}

/** Resolved (defaults-applied) attachment description, retained on the render
 *  target so `webglcontextrestored` can rebuild the exact same GPU set. */
interface ResolvedRTConfig {
    internalFormat: GLenum;
    format: GLenum;
    type: GLenum;
    hasDepth: boolean;
    minFilter: GLenum;
    magFilter: GLenum;
    wrapS: GLenum;
    wrapT: GLenum;
    /** True when the RT created (and therefore owns/restores/deletes) its color
     *  texture; false for a BYO {@link GLRenderTargetOptions.colorTexture}. */
    ownsColorTexture: boolean;
}

/**
 * An offscreen render target — a `WebGLFramebuffer` wrapping a color
 * {@link GLTexture} and an optional depth / stencil renderbuffer. The lite-gl
 * counterpart of Babylon's `RenderTargetWrapper`.
 */
export interface GLRenderTarget {
    /** The color attachment, sampleable like any other {@link GLTexture}
     *  (`setEffectTexture` / `bindTexture`). For an owned attachment its handle
     *  is swapped on `webglcontextrestored` while consumers keep this same
     *  reference. */
    texture: GLTexture;
    /** Color attachment width in texels. */
    width: number;
    /** Color attachment height in texels. */
    height: number;
    /** True once the color attachment + framebuffer are allocated. */
    isReady: boolean;
    /** @internal The framebuffer object. Swapped on context-restore. */
    _framebuffer: WebGLFramebuffer | null;
    /** @internal Depth-only (`DEPTH_COMPONENT16`) renderbuffer built by the core,
     *  OR the packed/stencil renderbuffer installed by `generateRenderTargetStencil`
     *  — a single field either way. Null when neither depth nor stencil is used. */
    _depthStencil: WebGLRenderbuffer | null;
    /**
     * @internal Optional stencil rebuild hook installed by
     * `generateRenderTargetStencil` (`@babylonjs/lite-gl/depth-stencil`). When
     * present it OWNS the depth/stencil renderbuffer (replacing the core
     * depth-only buffer) and is re-invoked after every FBO rebuild
     * (create-via-helper, resize, context-restore) so the attachment survives.
     */
    _rebuildDepthStencil?: (engine: GLEngineContext) => void;
    /** @internal Resolved attachment config, for context-restore rebuild. */
    _config: ResolvedRTConfig;
    /** @internal */
    _disposed: boolean;
    /** @internal Delete every GPU object the target owns (FBO, renderbuffer, and
     *  the color texture iff owned). Resets the bound-framebuffer cache if it
     *  pointed at this target. Called by `disposeRenderTarget`, `resizeRenderTarget`
     *  and engine dispose. */
    _deleteGpu: (gl: WebGL2RenderingContext) => void;
    /** @internal Rebuild the FBO + renderbuffer (+ owned color texture) into
     *  fresh handles after `webglcontextrestored`. */
    _restore: (engine: GLEngineContext) => void;
}

/**
 * A pair of {@link GLRenderTarget}s for self-feedback effects: SAMPLE the
 * {@link GLPingPong.read | read} target (last frame's output) while RENDERING
 * into the {@link GLPingPong.write | write} target, then {@link GLPingPong.swap}.
 */
export interface GLPingPong {
    /** The target to SAMPLE this frame (the previous frame's output). */
    readonly read: GLRenderTarget;
    /** The target to RENDER into this frame. */
    readonly write: GLRenderTarget;
    /** Exchange `read` and `write`. Call after rendering the `write` target each
     *  frame. Allocation-free — flips an internal index, no objects created. */
    swap(): void;
    /** @internal */
    _a: GLRenderTarget;
    /** @internal */
    _b: GLRenderTarget;
    /** @internal */
    _readIsA: boolean;
    /** @internal */
    _disposed: boolean;
}

/**
 * Create an offscreen **RGBA8** render target.
 *
 * The color attachment is an owned {@link GLTexture} (rebuilt by this target's
 * own restore hook), unless {@link GLRenderTargetOptions.colorTexture} supplies a
 * caller-managed (BYO) one. Mirrors Babylon's `createRenderTargetTexture`.
 *
 * @param engine - The engine to allocate GL resources on.
 * @param options - See {@link GLRenderTargetOptions} (`width`/`height` required).
 * @returns The new {@link GLRenderTarget}.
 * @throws If `width`/`height` are not positive integers, a GL handle could not
 *  be allocated, or the resulting framebuffer is not complete. On failure every
 *  partial GPU object (including an owned color texture) is released first.
 */
export function createRenderTarget(engine: GLEngineContext, options: GLRenderTargetOptions): GLRenderTarget {
    return buildRT(engine, options, RGBA8, RGBA, UNSIGNED_BYTE);
}

/**
 * Create an offscreen **float / half-float** render target — the HDR opt-in
 * counterpart of {@link createRenderTarget}. This is the only render-target
 * factory that references the `RGBA16F` / `RGBA32F` sized-format table, so RGBA8
 * consumers ship none of it.
 *
 * Defaults to `gl.HALF_FLOAT`; pass `options.type = gl.FLOAT` for full 32-bit.
 * The requested type is downgraded to the best renderable type the engine
 * supports (mirroring Babylon's `getTextureType`).
 *
 * @param engine - The engine to allocate GL resources on.
 * @param options - See {@link GLFloatRenderTargetOptions}.
 * @returns The new {@link GLRenderTarget}.
 * @throws As {@link createRenderTarget}.
 */
export function createFloatRenderTarget(engine: GLEngineContext, options: GLFloatRenderTargetOptions): GLRenderTarget {
    const type = resolveColorType(engine, options.type ?? HALF_FLOAT);
    const internalFormat = pickSizedInternalFormat(engine.gl, RGBA, type);
    return buildRT(engine, options, internalFormat, RGBA, type);
}

/**
 * Bind the render target's framebuffer as the draw target and set the viewport
 * to cover it. `rt = null` binds the default (canvas) framebuffer and resets the
 * viewport to the full canvas — the counterpart of Babylon's
 * `restoreDefaultFramebuffer`. Subsequent `drawEffect` / `drawIndexed` /
 * `clearEngine` calls write into the bound target.
 *
 * Cached. No-op on a lost/disposed context or a disposed `rt`. Mipmaps are NOT
 * regenerated here — refresh a target's mip chain explicitly via
 * {@link generateRenderTargetMipMaps} after rendering into it.
 *
 * @param engine - The engine.
 * @param rt - The render target to draw into, or `null` for the canvas.
 */
export function bindRenderTarget(engine: GLEngineContext, rt: GLRenderTarget | null): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    if (rt !== null && rt._disposed) {
        return;
    }
    const gl = engine.gl;
    const s = engine._state;
    const fb = rt === null ? null : rt._framebuffer;
    if (s.boundFramebuffer !== fb) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        s.boundFramebuffer = fb;
    }
    engine._currentRenderTarget = rt;
    if (rt === null) {
        setViewportCached(engine, 0, 0, engine.canvas.width, engine.canvas.height);
    } else {
        setViewportCached(engine, 0, 0, rt.width, rt.height);
    }
}

/** Regenerate a render target's color-attachment mip chain from its (freshly
 *  rendered) level-0 — mipmaps for render targets are a pure manual opt-in
 *  (call this after rendering into the target). No-op for a disposed target, a
 *  handle-less color attachment, or a lost/disposed context. */
export function generateRenderTargetMipMaps(engine: GLEngineContext, rt: GLRenderTarget): void {
    if (engine._isLost || engine._disposed || rt._disposed || rt.texture.handle === null) {
        return;
    }
    bindTextureForUpload(engine, rt.texture.handle);
    engine.gl.generateMipmap(engine.gl.TEXTURE_2D);
}

/**
 * Resize the render target's color attachment (and depth/stencil renderbuffer).
 * Reallocates storage at the new size; the contents are discarded. The
 * `GLRenderTarget` / `GLTexture` identity is preserved, so consumers and
 * effect-sampler bindings holding the reference stay valid. If this target was
 * the live draw target, it is rebound (with the new-size viewport) afterwards.
 *
 * No-op when the size is unchanged or `rt` is disposed. While the context is
 * lost the new size is recorded but the GL reallocation is deferred to the
 * restore hook.
 *
 * @param engine - The engine.
 * @param rt - The render target to resize.
 * @param width - New width in texels (≥ 1).
 * @param height - New height in texels (≥ 1).
 */
export function resizeRenderTarget(engine: GLEngineContext, rt: GLRenderTarget, width: number, height: number): void {
    if (rt._disposed) {
        return;
    }
    validateSize(width, height);
    if (rt.width === width && rt.height === height) {
        return;
    }
    rt.width = width;
    rt.height = height;
    rt.texture.width = width;
    rt.texture.height = height;
    if (engine._isLost || engine._disposed) {
        return;
    }
    // Capture the live binding BEFORE we delete the old FBO so we can restore it.
    const wasBound = engine._state.boundFramebuffer === rt._framebuffer && rt._framebuffer !== null;
    // For a BYO color texture, re-specify the caller's storage at the new size
    // (contents discarded, like the owned path). `_updateRaw` updates the
    // texture's tracked dims AND re-runs its upload closure — `_upload` alone
    // would re-upload at the stale ORIGINAL size, leaving the attachment a
    // different size than the FBO. An external handle without `_updateRaw` must
    // be resized by its owner; we then just rebuild the FBO around it. An owned
    // texture is recreated wholesale by allocateRenderTargetGpu.
    if (!rt._config.ownsColorTexture) {
        rt.texture._updateRaw?.(engine, null, width, height, 4);
    }
    rt._deleteGpu(engine.gl);
    allocateRenderTargetGpu(engine, rt);
    if (wasBound) {
        bindRenderTarget(engine, rt);
    }
}

/**
 * Synchronously read back a rectangle of the render target's color attachment
 * via `gl.readPixels` — the lite-gl equivalent of Babylon's
 * `_readTexturePixelsSync`. Binds the target's framebuffer (leaving it bound,
 * matching Babylon).
 *
 * The returned array element type follows the color attachment type:
 * `Uint8Array` for `UNSIGNED_BYTE`, `Float32Array` for `FLOAT`, `Uint16Array`
 * for `HALF_FLOAT`. Origin is GL bottom-left.
 *
 * @param engine - The engine.
 * @param rt - The render target to read from.
 * @param x - Lower-left X of the read rectangle, in texels.
 * @param y - Lower-left Y of the read rectangle, in texels.
 * @param width - Read rectangle width in texels.
 * @param height - Read rectangle height in texels.
 * @param into - Optional preallocated buffer (`width*height*4` elements of the
 *  matching type). Reused to avoid per-call allocation.
 * @returns The pixel buffer (the provided `into`, or a freshly allocated one).
 *  Empty buffer on a lost/disposed context.
 */
export function readRenderTargetPixels(engine: GLEngineContext, rt: GLRenderTarget, x: number, y: number, width: number, height: number, into?: ArrayBufferView): ArrayBufferView {
    const elements = width * height * 4;
    if (engine._isLost || engine._disposed || rt._disposed) {
        return into ?? new Uint8Array(0);
    }
    const gl = engine.gl;
    const s = engine._state;
    if (s.boundFramebuffer !== rt._framebuffer) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, rt._framebuffer);
        s.boundFramebuffer = rt._framebuffer;
    }
    const type = rt._config.type;
    let buffer = into;
    if (buffer === undefined) {
        buffer = type === gl.FLOAT ? new Float32Array(elements) : type === gl.HALF_FLOAT ? new Uint16Array(elements) : new Uint8Array(elements);
    }
    gl.readPixels(x, y, width, height, gl.RGBA, type, buffer);
    return buffer;
}

/**
 * Release the render target's framebuffer, depth/stencil renderbuffer and (iff
 * owned) color texture, and unregister it from the engine. Idempotent, and a
 * no-op for `null`/`undefined` (so an optional target can be released
 * unconditionally). Clears the bound-framebuffer cache if it pointed at this
 * target, and any sampler slot that held the color texture handle.
 *
 * A BYO {@link GLRenderTargetOptions.colorTexture} is NOT disposed here — it is
 * engine-managed and the caller owns its lifetime.
 *
 * @param engine - The engine.
 * @param rt - The render target to dispose, or `null`/`undefined` for a no-op.
 */
export function disposeRenderTarget(engine: GLEngineContext, rt: GLRenderTarget | null | undefined): void {
    if (rt === null || rt === undefined || rt._disposed) {
        return;
    }
    rt._disposed = true;
    // Only the owned color texture is marked disposed here; a BYO texture stays
    // live for its caller-owner.
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
    // Capture the handle before _deleteGpu nulls it (owned case).
    const handle = rt.texture.handle;
    if (!engine._isLost && !engine._disposed) {
        rt._deleteGpu(engine.gl);
    } else {
        rt._framebuffer = null;
        rt._depthStencil = null;
    }
    if (handle !== null) {
        const bound = engine._state.boundTextures;
        for (let u = 0; u < bound.length; u++) {
            if (bound[u] === handle) {
                bound[u] = null;
            }
        }
    }
}

/**
 * Create a {@link GLPingPong}: two same-sized {@link GLRenderTarget}s for
 * self-feedback effects. `read` starts as the first target and `write` the
 * second; {@link GLPingPong.swap} exchanges them allocation-free.
 *
 * @param engine - The engine to create GL resources on.
 * @param options - Applied identically to both targets.
 * @returns The new {@link GLPingPong}.
 * @throws As {@link createRenderTarget}. If the second target fails to build the
 *  first is disposed before rethrowing (no leak).
 */
export function createPingPong(engine: GLEngineContext, options: GLRenderTargetOptions): GLPingPong {
    const a = createRenderTarget(engine, options);
    let b: GLRenderTarget;
    try {
        b = createRenderTarget(engine, options);
    } catch (e) {
        disposeRenderTarget(engine, a);
        throw e;
    }
    const pp: GLPingPong = {
        _a: a,
        _b: b,
        _readIsA: true,
        _disposed: false,
        get read(): GLRenderTarget {
            return pp._readIsA ? pp._a : pp._b;
        },
        get write(): GLRenderTarget {
            return pp._readIsA ? pp._b : pp._a;
        },
        swap(): void {
            pp._readIsA = !pp._readIsA;
        },
    };
    return pp;
}

/**
 * Resize both targets of a {@link GLPingPong}. No-op when disposed.
 *
 * @param engine - The engine that owns `pp`.
 * @param pp - The ping-pong pair to resize.
 * @param width - New width in texels (positive integer).
 * @param height - New height in texels (positive integer).
 */
export function resizePingPong(engine: GLEngineContext, pp: GLPingPong, width: number, height: number): void {
    if (pp._disposed) {
        return;
    }
    resizeRenderTarget(engine, pp._a, width, height);
    resizeRenderTarget(engine, pp._b, width, height);
}

/**
 * Release both targets of a {@link GLPingPong}. Idempotent, and a no-op for
 * `null`/`undefined` (matching {@link disposeRenderTarget}).
 *
 * @param engine - The engine that owns `pp`.
 * @param pp - The ping-pong pair to release, or `null`/`undefined` for a no-op.
 */
export function disposePingPong(engine: GLEngineContext, pp: GLPingPong | null | undefined): void {
    if (pp === null || pp === undefined || pp._disposed) {
        return;
    }
    pp._disposed = true;
    disposeRenderTarget(engine, pp._a);
    disposeRenderTarget(engine, pp._b);
}

/* ────────────────────────────  internal helpers  ──────────────────────────── */

/** Shared private constructor. Validates size, resolves the config (given the
 *  exact sized `internalFormat` by the caller — NO format-table lookup), wires
 *  the owned-or-BYO color texture, allocates the GPU set atomically, and
 *  registers the target. */
function buildRT(engine: GLEngineContext, options: GLRenderTargetOptions, internalFormat: GLenum, format: GLenum, type: GLenum): GLRenderTarget {
    const width = options.width;
    const height = options.height;
    validateSize(width, height);
    const gl = engine.gl;
    const byo = options.colorTexture;
    const config: ResolvedRTConfig = {
        internalFormat,
        format,
        type,
        hasDepth: options.generateDepthBuffer ?? false,
        minFilter: options.minFilter ?? LINEAR,
        magFilter: options.magFilter ?? LINEAR,
        wrapS: options.wrapS ?? CLAMP_TO_EDGE,
        wrapT: options.wrapT ?? CLAMP_TO_EDGE,
        ownsColorTexture: byo === undefined,
    };

    const texture: GLTexture = byo ?? {
        handle: null as unknown as WebGLTexture,
        target: gl.TEXTURE_2D,
        width,
        height,
        isReady: false,
        _disposed: false,
        _refCount: 1,
        // Owned-by-RT: its storage is (re)allocated by allocateRenderTargetGpu,
        // never via the engine `_textures` replay (it is NOT registered there).
        _upload: () => {},
        _wasReady: false,
    };

    const rt: GLRenderTarget = {
        texture,
        width,
        height,
        isReady: false,
        _framebuffer: null,
        _depthStencil: null,
        _rebuildDepthStencil: undefined,
        _config: config,
        _disposed: false,
        _deleteGpu: () => {},
        _restore: () => {},
    };

    rt._deleteGpu = (glc: WebGL2RenderingContext): void => {
        const s = engine._state;
        if (rt._framebuffer !== null) {
            // Deleting the bound FBO reverts GL to framebuffer 0 (spec) — just
            // reset the cache, no explicit rebind needed.
            if (s.boundFramebuffer === rt._framebuffer) {
                s.boundFramebuffer = null;
            }
            glc.deleteFramebuffer(rt._framebuffer);
            rt._framebuffer = null;
        }
        if (rt._depthStencil !== null) {
            glc.deleteRenderbuffer(rt._depthStencil);
            rt._depthStencil = null;
        }
        // Never delete a BYO color texture — the caller-owner manages it.
        if (config.ownsColorTexture && rt.texture.handle !== null) {
            glc.deleteTexture(rt.texture.handle);
            rt.texture.handle = null as unknown as WebGLTexture;
        }
        rt.texture.isReady = false;
        rt.isReady = false;
    };

    rt._restore = (target: GLEngineContext): void => {
        // Resilient: a restore failure must not break the engine's restore loop.
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

/** Downgrade a requested float/half-float color type to the best renderable
 *  type the engine supports, mirroring Babylon's `getTextureType`. */
function resolveColorType(engine: GLEngineContext, type: GLenum): GLenum {
    const gl = engine.gl;
    if (type === FLOAT && !engine.caps.textureFloatRender) {
        return engine.caps.textureHalfFloatRender ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    }
    if (type === HALF_FLOAT && !engine.caps.textureHalfFloatRender) {
        return gl.UNSIGNED_BYTE;
    }
    return type;
}

/** Validate a render-target size is a pair of positive integers. */
function validateSize(width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new Error(`lite-gl: render target size must be positive integers, got ${width}x${height}`);
    }
}

/**
 * (Re)allocate the color texture (iff owned), framebuffer and depth/stencil
 * renderbuffer into fresh handles, attach them, and validate completeness.
 * Shared by create / resize / context-restore. No-op on a lost/disposed context.
 *
 * ATOMIC: captures the previously-bound framebuffer and restores it in a
 * `finally`; on any failure deletes the partial FBO / renderbuffer (and the
 * owned color texture it created), nulls the fields, and rethrows — so a failed
 * build never leaks a GPU handle nor leaves a half-attached framebuffer bound.
 */
function allocateRenderTargetGpu(engine: GLEngineContext, rt: GLRenderTarget): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const gl = engine.gl;
    const s = engine._state;
    const c = rt._config;
    const prevFb = s.boundFramebuffer;
    let createdTexture: WebGLTexture | null = null;
    let fb: WebGLFramebuffer | null = null;
    let rb: WebGLRenderbuffer | null = null;
    try {
        // ── Color texture (owned only) ───────────────────────────────────────
        if (c.ownsColorTexture) {
            const texHandle = gl.createTexture();
            if (texHandle === null) {
                throw new Error("lite-gl: gl.createTexture returned null (render target color)");
            }
            createdTexture = texHandle;
            rt.texture.handle = texHandle;
            bindTextureForUpload(engine, texHandle);
            gl.texImage2D(gl.TEXTURE_2D, 0, c.internalFormat, rt.width, rt.height, 0, c.format, c.type, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, c.minFilter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, c.magFilter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, c.wrapS);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, c.wrapT);
            rt.texture.isReady = true;
            rt.texture._wasReady = true;
        }

        // ── Framebuffer + attachments ────────────────────────────────────────
        fb = gl.createFramebuffer();
        if (fb === null) {
            throw new Error("lite-gl: gl.createFramebuffer returned null");
        }
        rt._framebuffer = fb;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        s.boundFramebuffer = fb;
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rt.texture.handle, 0);

        // ── Depth (core, DEPTH-ONLY) ─────────────────────────────────────────
        // The core only ever builds a DEPTH_COMPONENT16 depth buffer. Stencil /
        // packed depth-stencil is an opt-in installed by
        // `generateRenderTargetStencil` (`@babylonjs/lite-gl/depth-stencil`),
        // which sets `_rebuildDepthStencil` to a closure that REPLACES the
        // depth-only buffer below with its own packed/stencil renderbuffer. That
        // hook is re-run here on every rebuild (create / resize / context-restore)
        // so a helper-added stencil attachment survives at the new size.
        rt._depthStencil = null;
        if (c.hasDepth) {
            rb = gl.createRenderbuffer();
            if (rb === null) {
                throw new Error("lite-gl: gl.createRenderbuffer returned null");
            }
            gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, rt.width, rt.height);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
            gl.bindRenderbuffer(gl.RENDERBUFFER, null);
            rt._depthStencil = rb;
        }
        // A helper-attached stencil replaces/augments the depth-only buffer.
        rt._rebuildDepthStencil?.(engine);

        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            throw new Error(`lite-gl: render target framebuffer incomplete (status 0x${status.toString(16)})`);
        }
        rt.isReady = true;
    } catch (e) {
        // Free whatever depth/stencil renderbuffer is currently attached. After a
        // `_rebuildDepthStencil` hook ran, `rt._depthStencil` may be a packed buffer
        // the hook swapped in (it deletes the core `rb` itself on success), so free
        // the live `rt._depthStencil` rather than the stale local `rb`.
        if (rt._depthStencil !== null) {
            gl.deleteRenderbuffer(rt._depthStencil);
        }
        rt._depthStencil = null;
        if (fb !== null) {
            gl.deleteFramebuffer(fb);
        }
        rt._framebuffer = null;
        // Delete ONLY a texture we created here (owned). Never a BYO texture.
        if (createdTexture !== null) {
            gl.deleteTexture(createdTexture);
            rt.texture.handle = null as unknown as WebGLTexture;
            rt.texture.isReady = false;
        }
        rt.isReady = false;
        throw e;
    } finally {
        // Restore the previously-bound draw target — creation/restore must not
        // silently redirect subsequent draws.
        if (s.boundFramebuffer !== prevFb) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
            s.boundFramebuffer = prevFb;
        }
    }
}

/** Inline cached `gl.viewport` — kept local so the render-target sub-entry has
 *  no runtime dependency on the effect-renderer module. */
function setViewportCached(engine: GLEngineContext, x: number, y: number, w: number, h: number): void {
    const s = engine._state;
    if (s.viewportX === x && s.viewportY === y && s.viewportW === w && s.viewportH === h) {
        return;
    }
    s.viewportX = x;
    s.viewportY = y;
    s.viewportW = w;
    s.viewportH = h;
    engine.gl.viewport(x, y, w, h);
}
