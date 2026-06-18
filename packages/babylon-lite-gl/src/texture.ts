import type { GLEngineContext } from "./context.js";

/** Texture sampling / wrap options. All have GL-spec defaults. Mipmaps are NOT
 *  a create option — generate the chain explicitly via {@link generateTextureMipMaps}. */
export interface GLTextureOptions {
    /** Default: false (matches Babylon's default raw-texture behaviour). */
    invertY?: boolean;
    /** Default: gl.LINEAR. */
    minFilter?: GLenum;
    /** Default: gl.LINEAR. */
    magFilter?: GLenum;
    /** Default: gl.CLAMP_TO_EDGE. May be `gl.REPEAT` / `gl.MIRRORED_REPEAT`
     *  (NPOT-safe in WebGL2). */
    wrapS?: GLenum;
    /** Default: gl.CLAMP_TO_EDGE. May be `gl.REPEAT` / `gl.MIRRORED_REPEAT`. */
    wrapT?: GLenum;
    /** `gl.pixelStorei(UNPACK_ALIGNMENT)` for the upload (1/2/4/8). Default 4.
     *  Use 1 for tightly-packed non-RGBA rows. */
    unpackAlignment?: number;
    /** Premultiply alpha at upload (`UNPACK_PREMULTIPLY_ALPHA_WEBGL`). Default
     *  false. */
    premultiplyAlpha?: boolean;
    /** Explicit sized internalFormat for `texImage2D`. When provided it is used
     *  verbatim and the inline LDR resolver is bypassed — this is how
     *  {@link createFloatTexture} injects its `RGBA16F` / `RGBA32F` choice
     *  without the byte path ever referencing the float-format table (keeping it
     *  tree-shakeable out of RGBA8-only bundles). Default: derived from
     *  `format`/`type` via the LDR resolver. */
    internalFormat?: GLenum;
}

/**
 * Pure-state texture handle. The `handle` field is MUTABLE so the same logical
 * texture survives a `webglcontextrestored` event — every consumer keeps the
 * same `GLTexture` reference; only the internal `WebGLTexture` is swapped.
 *
 * `loadTexture2D` also uses the same handle for the 1×1 placeholder upload AND
 * the final image upload — so a `bindTexture(engine, unit, tex)` made before the
 * image has decoded remains valid once the image arrives.
 */
export interface GLTexture {
    /** The live `WebGLTexture`. MUTABLE — swapped for a fresh handle on
     *  `webglcontextrestored` while consumers keep the same `GLTexture` reference. */
    handle: WebGLTexture;
    /** GL texture target (always `gl.TEXTURE_2D` for this package). */
    readonly target: GLenum;
    /** Texture width in texels. Updated once an async upload resolves. */
    width: number;
    /** Texture height in texels. Updated once an async upload resolves. */
    height: number;
    /** True when the texture is safe to sample with final content (placeholders
     *  read as not-ready until their image/upload completes). */
    isReady: boolean;
    /** @internal */
    _disposed: boolean;
    /** @internal */
    _refCount: number;
    /**
     * Replay closure for context-restore (§4.7 of 00-lite-gl.md). Captures the
     * original upload arguments and re-issues the `gl.texImage2D` /
     * `texParameteri` sequence into the freshly-allocated `handle`. After
     * the upload completes the texture is ready iff `_isReadyAfterUpload`.
     * @internal
     */
    _upload: (engine: GLEngineContext) => void;
    /**
     * Snapshot of `isReady` captured on `webglcontextlost` so the restore
     * handler knows whether to flip it back on after `_upload`. Textures
     * that were still mid-load (e.g. `loadTexture2D` whose bitmap hadn't
     * arrived) stay not-ready; the async path will set `isReady=true` once
     * the bitmap finishes decoding into the new handle.
     * @internal
     */
    _wasReady: boolean;
    /**
     * Live re-upload hook installed by `createRawTexture` — lets
     * `updateRawTexture` replace the pixel data (and optionally the size)
     * through the same closure that the context-restore replay uses, keeping
     * restore correct. Absent on image / HTML-element / external textures.
     * @internal
     */
    _updateRaw?: (engine: GLEngineContext, data: ArrayBufferView | null, width: number, height: number, unpackAlignment: number) => void;
    /**
     * Dynamic-texture source captured by `updateDynamicTexture`
     * (`@babylonjs/lite-gl/dynamic-texture`) and replayed into the fresh handle
     * on `webglcontextrestored`. Null/absent on non-dynamic textures.
     * @internal
     */
    _dynSource?: TexImageSource | null;
    /** UNPACK_FLIP_Y applied when replaying {@link GLTexture._dynSource}. @internal */
    _dynInvertY?: boolean;
    /** UNPACK_PREMULTIPLY_ALPHA applied when replaying {@link GLTexture._dynSource}. @internal */
    _dynPremultiplyAlpha?: boolean;
    /**
     * The `handle` the dynamic texture's `texParameteri` filter/wrap state was
     * last applied to. `texParameteri` is per-texture GL state that survives pixel
     * re-uploads, so the dynamic-texture `_upload` re-applies it ONLY when this no
     * longer matches `handle` — i.e. at creation and after `webglcontextrestored`
     * installs a fresh handle — not on every per-frame `updateDynamicTexture`.
     * @internal
     */
    _dynParamsHandle?: WebGLTexture | null;
}

/**
 * Apply the three `UNPACK_*` pixel-store flags through the GL-state cache,
 * eliding redundant `pixelStorei` calls. Centralising this guarantees EVERY
 * upload path sets all three explicitly, so a premultiplying / flipping upload
 * never leaks its flag into a later upload that forgot to set it.
 * @internal
 */
export function setUnpackState(engine: GLEngineContext, flipY: boolean, premultiplyAlpha: boolean, alignment = 4): void {
    const gl = engine.gl;
    const s = engine._state;
    const fy = flipY ? 1 : 0;
    if (s.unpackFlipY !== fy) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, fy);
        s.unpackFlipY = fy;
    }
    const pm = premultiplyAlpha ? 1 : 0;
    if (s.unpackPremultiplyAlpha !== pm) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, pm);
        s.unpackPremultiplyAlpha = pm;
    }
    if (s.unpackAlignment !== alignment) {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
        s.unpackAlignment = alignment;
    }
}

/** Uint8 / float raw texture upload. The pixel data can be replaced later via
 *  {@link updateRawTexture}; the sampling and wrap can be changed via
 *  {@link updateTextureSamplingMode} / {@link updateTextureWrapMode}. */
export function createRawTexture(
    engine: GLEngineContext,
    data: ArrayBufferView | null,
    width: number,
    height: number,
    format: GLenum,
    type: GLenum,
    options?: GLTextureOptions
): GLTexture {
    const gl = engine.gl;
    const handle = gl.createTexture();
    if (handle === null) {
        throw new Error("lite-gl: gl.createTexture returned null");
    }
    const opts = options ?? {};
    const minFilter = opts.minFilter ?? gl.LINEAR;
    const magFilter = opts.magFilter ?? gl.LINEAR;
    const wrapS = opts.wrapS ?? gl.CLAMP_TO_EDGE;
    const wrapT = opts.wrapT ?? gl.CLAMP_TO_EDGE;
    const invertY = opts.invertY ?? false;
    const premultiply = opts.premultiplyAlpha ?? false;
    // LDR byte formats are resolved INLINE here; the float-format table in
    // `pickSizedInternalFormat` is deliberately NOT referenced from this path so
    // it tree-shakes out of byte-only bundles. `createFloatTexture` injects its
    // sized float format via `opts.internalFormat`.
    const internalFormat = opts.internalFormat ?? resolveLdrInternalFormat(gl, format, type);

    // Mutable upload state — `updateRawTexture` mutates these and re-runs
    // `upload`, so the context-restore replay (which calls the same `upload`)
    // always reproduces the latest contents.
    let curData = data;
    let curWidth = width;
    let curHeight = height;
    let curAlign = opts.unpackAlignment ?? 4;

    const upload = (target: GLEngineContext): void => {
        const g = target.gl;
        setUnpackState(target, invertY, premultiply, curAlign);
        bindTextureForUpload(target, tex.handle);
        g.texImage2D(g.TEXTURE_2D, 0, internalFormat, curWidth, curHeight, 0, format, type, curData);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, minFilter);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, magFilter);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, wrapS);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, wrapT);
    };

    const tex: GLTexture = {
        handle,
        target: gl.TEXTURE_2D,
        width,
        height,
        isReady: true,
        _disposed: false,
        _refCount: 1,
        _upload: upload,
        _wasReady: true,
    };
    tex._updateRaw = (target: GLEngineContext, newData: ArrayBufferView | null, newWidth: number, newHeight: number, unpackAlignment: number): void => {
        curData = newData;
        curWidth = newWidth;
        curHeight = newHeight;
        curAlign = unpackAlignment;
        tex.width = newWidth;
        tex.height = newHeight;
        upload(target);
    };
    upload(engine);
    engine._textures.push(tex);
    return tex;
}

/** Options for {@link createFloatTexture} — the shared {@link GLTextureOptions}
 *  plus the float-specific `type` / `format`. */
export interface GLFloatTextureOptions extends GLTextureOptions {
    /** Float texel type — `gl.HALF_FLOAT` (default) or `gl.FLOAT`. */
    type?: GLenum;
    /** Color format. Default `gl.RGBA`. */
    format?: GLenum;
}

/**
 * Create a float / half-float raw texture — the HDR counterpart of
 * {@link createRawTexture}. This is the ONLY texture factory that carries the
 * `RGBA16F` / `RGBA32F` sized-format knowledge (via {@link pickSizedInternalFormat}),
 * so byte-only consumers calling {@link createRawTexture} ship none of it.
 * Defaults to `gl.HALF_FLOAT`; pass `options.type = gl.FLOAT` for full 32-bit.
 * The caller is responsible for the matching engine cap (e.g.
 * `caps.textureFloatLinearFiltering`) when sampling these with `LINEAR`.
 *
 * @param engine - The engine.
 * @param data - Initial pixels (`Float32Array` for FLOAT, `Uint16Array` for
 *  HALF_FLOAT), or `null` for an uninitialised allocation.
 * @param width - Texture width in texels (≥ 1).
 * @param height - Texture height in texels (≥ 1).
 * @param options - See {@link GLFloatTextureOptions}.
 * @returns The new {@link GLTexture}.
 */
export function createFloatTexture(engine: GLEngineContext, data: ArrayBufferView | null, width: number, height: number, options?: GLFloatTextureOptions): GLTexture {
    const gl = engine.gl;
    const o = options ?? {};
    const format = o.format ?? gl.RGBA;
    const type = o.type ?? gl.HALF_FLOAT;
    // Precompute the sized float internalFormat HERE and pass it through, so
    // `createRawTexture`'s inline LDR resolver is bypassed and the float table
    // stays out of byte-only bundles.
    const internalFormat = pickSizedInternalFormat(gl, format, type);
    return createRawTexture(engine, data, width, height, format, type, { ...o, internalFormat });
}

/** Generate the mip chain for a texture from its level-0 contents — mipmaps as
 *  an explicit opt-in function rather than baked into the create path. Binds for
 *  upload (unit 0). No-op on a lost/disposed context or a handle-less texture. */
export function generateTextureMipMaps(engine: GLEngineContext, tex: GLTexture): void {
    if (engine._isLost || engine._disposed || tex._disposed || tex.handle === null) {
        return;
    }
    bindTextureForUpload(engine, tex.handle);
    engine.gl.generateMipmap(engine.gl.TEXTURE_2D);
}

/**
 * Re-upload the pixel data (and optionally resize) of a texture created by
 * {@link createRawTexture} — the lite-gl equivalent of Babylon's
 * `updateRawTexture` / `_uploadDataToTextureDirectly`. Goes through the same
 * upload closure used by context-restore, so the new contents survive a context
 * loss. No-op on a lost/disposed/non-raw texture.
 *
 * @param engine - The engine.
 * @param tex - The raw texture to update.
 * @param data - New pixel data (must match the original `format`/`type`).
 * @param options - Optional new `width`/`height` (default: unchanged) and
 *  `unpackAlignment` (default 4).
 */
export function updateRawTexture(
    engine: GLEngineContext,
    tex: GLTexture,
    data: ArrayBufferView | null,
    options?: { width?: number; height?: number; unpackAlignment?: number }
): void {
    if (engine._isLost || engine._disposed || tex._disposed || tex._updateRaw === undefined) {
        return;
    }
    const o = options ?? {};
    tex._updateRaw(engine, data, o.width ?? tex.width, o.height ?? tex.height, o.unpackAlignment ?? 4);
}

/** Update a texture's min/mag sampling filters — the lite-gl equivalent of
 *  Babylon's `updateTextureSamplingMode`. Binds for upload (unit 0) so the
 *  `texParameteri` lands on this texture. No-op on a lost/disposed context. */
export function updateTextureSamplingMode(engine: GLEngineContext, tex: GLTexture, minFilter: GLenum, magFilter: GLenum): void {
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    const gl = engine.gl;
    bindTextureForUpload(engine, tex.handle);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
}

/** Update a texture's S/T wrap modes (`gl.CLAMP_TO_EDGE` / `gl.REPEAT` /
 *  `gl.MIRRORED_REPEAT`) — the lite-gl equivalent of Babylon's
 *  `updateTextureWrappingMode`. No-op on a lost/disposed context. */
export function updateTextureWrapMode(engine: GLEngineContext, tex: GLTexture, wrapS: GLenum, wrapT: GLenum): void {
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    const gl = engine.gl;
    bindTextureForUpload(engine, tex.handle);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
}

/**
 * Wrap an existing raw `WebGLTexture` (e.g. one created by a host renderer or a
 * previous engine) as a {@link GLTexture} — the lite-gl equivalent of
 * ShapeBuilder's `createTextureGraphicsResourceFromExternalWebGLTexture`.
 *
 * The wrapper does NOT own the underlying handle's upload — it is NOT registered
 * for context-restore replay (the external owner is responsible for that) and is
 * marked ready immediately. `disposeTexture` will still `gl.deleteTexture` it, so
 * only wrap a handle whose deletion you intend lite-gl to manage.
 *
 * @param engine - The engine.
 * @param handle - The external `WebGLTexture`.
 * @param width - Texture width in texels.
 * @param height - Texture height in texels.
 * @param options - Optional sampling/wrap to apply once (min/mag/wrapS/wrapT).
 * @returns A {@link GLTexture} wrapping the handle.
 */
export function createTextureFromHandle(engine: GLEngineContext, handle: WebGLTexture, width: number, height: number, options?: GLTextureOptions): GLTexture {
    const tex: GLTexture = {
        handle,
        target: engine.gl.TEXTURE_2D,
        width,
        height,
        isReady: true,
        _disposed: false,
        _refCount: 1,
        // External handle — restore replay is the external owner's job.
        _upload: () => {},
        _wasReady: true,
    };
    if (options !== undefined) {
        const gl = engine.gl;
        bindTextureForUpload(engine, handle);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, options.minFilter ?? gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, options.magFilter ?? gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, options.wrapS ?? gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, options.wrapT ?? gl.CLAMP_TO_EDGE);
    }
    return tex;
}

/** Asynchronous image upload.The returned texture is immediately usable (1×1
 *  transparent placeholder); `isReady` flips true once the image has been
 *  decoded and uploaded. The decoded `ImageBitmap` is retained on the texture
 *  for offline-safe `webglcontextrestored` replay. */
export function loadTexture2D(engine: GLEngineContext, url: string, options?: GLTextureOptions, onLoad?: (tex: GLTexture) => void, onError?: (err: Error) => void): GLTexture {
    const gl = engine.gl;
    const handle = gl.createTexture();
    if (handle === null) {
        throw new Error("lite-gl: gl.createTexture returned null");
    }
    const opts = options ?? {};
    const minFilter = opts.minFilter ?? gl.LINEAR;
    const magFilter = opts.magFilter ?? gl.LINEAR;
    const wrapS = opts.wrapS ?? gl.CLAMP_TO_EDGE;
    const wrapT = opts.wrapT ?? gl.CLAMP_TO_EDGE;
    const invertY = opts.invertY ?? false;

    let bitmap: ImageBitmap | null = null;
    const placeholderPixels = new Uint8Array([0, 0, 0, 0]);

    const upload = (target: GLEngineContext): void => {
        const g = target.gl;
        // invertY is applied at decode time via createImageBitmap({ imageOrientation })
        // because UNPACK_FLIP_Y_WEBGL is IGNORED for ImageBitmap sources (and the 1×1
        // placeholder is flip-invariant), so keep flip + premultiply off here.
        setUnpackState(target, false, false);
        bindTextureForUpload(target, tex.handle);
        if (bitmap !== null) {
            g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, bitmap);
            tex.width = bitmap.width;
            tex.height = bitmap.height;
        } else {
            g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, 1, 1, 0, g.RGBA, g.UNSIGNED_BYTE, placeholderPixels);
        }
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, minFilter);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, magFilter);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, wrapS);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, wrapT);
    };

    const tex: GLTexture = {
        handle,
        target: gl.TEXTURE_2D,
        width: 1,
        height: 1,
        isReady: false,
        _disposed: false,
        _refCount: 1,
        _upload: upload,
        _wasReady: false,
    };
    // Placeholder upload — makes the texture sampleable before the real image arrives.
    upload(engine);
    engine._textures.push(tex);

    // Fetch + decode the real image. Re-uploads via the same closure once the
    // bitmap is in hand (so context-restore replay sees the real image too).
    fetch(url)
        .then((r) => {
            if (!r.ok) {
                throw new Error(`lite-gl: fetch ${url} -> HTTP ${r.status}`);
            }
            return r.blob();
        })
        .then((blob) => createImageBitmap(blob, { premultiplyAlpha: "none", imageOrientation: invertY ? "flipY" : "none" }))
        .then((bm) => {
            if (tex._disposed) {
                bm.close();
                return;
            }
            bitmap = bm;
            // If the context is lost mid-flight, defer the upload — the restore
            // handler will call _upload again, which will then see `bitmap !== null`
            // and replay the real image.
            if (!engine._isLost) {
                upload(engine);
                tex.isReady = true;
            }
            tex._wasReady = true;
            if (onLoad !== undefined) {
                onLoad(tex);
            }
        })
        .catch((err: unknown) => {
            const e = err instanceof Error ? err : new Error(String(err));
            if (onError !== undefined) {
                onError(e);
            } else {
                console.error("lite-gl: loadTexture2D failed", e);
            }
        });

    return tex;
}

/** Cached bind. Skips `gl.activeTexture` and/or `gl.bindTexture` when nothing
 *  changes. No-op when `tex._disposed` or `engine._isLost`. */
export function bindTexture(engine: GLEngineContext, unit: number, tex: GLTexture | null): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    if (tex !== null && tex._disposed) {
        return;
    }
    bindTextureRaw(engine, unit, tex === null ? null : tex.handle);
}

/** @internal — for callers that already hold a raw `WebGLTexture`. Not part of
 *  the public API: `bindTexture` (public) and the texture `_upload` closures bind
 *  through the cache, so consumers never call this directly. */
export function bindTextureRaw(engine: GLEngineContext, unit: number, handle: WebGLTexture | null): void {
    const s = engine._state;
    const gl = engine.gl;
    if (s.boundTextures[unit] === handle) {
        return;
    }
    if (s.activeTextureUnit !== unit) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        s.activeTextureUnit = unit;
    }
    gl.bindTexture(gl.TEXTURE_2D, handle);
    s.boundTextures[unit] = handle;
}

/** @internal Bind `handle` on texture unit 0 **for an upload** (`texImage2D`).
 *  Unlike {@link bindTextureRaw} — which elides the entire bind when the handle is
 *  already bound on the unit (correct for *sampling*, where the active unit is
 *  irrelevant) — an upload writes into the texture on the ACTIVE unit. A prior
 *  multi-sampler draw may have left a non-zero unit active while this handle is
 *  still bound on unit 0, so we must force unit 0 active even on a bind cache-hit,
 *  keeping the `_state` cache coherent. */
export function bindTextureForUpload(engine: GLEngineContext, handle: WebGLTexture): void {
    const s = engine._state;
    const gl = engine.gl;
    if (s.activeTextureUnit !== 0) {
        gl.activeTexture(gl.TEXTURE0);
        s.activeTextureUnit = 0;
    }
    if (s.boundTextures[0] !== handle) {
        gl.bindTexture(gl.TEXTURE_2D, handle);
        s.boundTextures[0] = handle;
    }
}

/** Disposes the texture. Walks `_state.boundTextures` and clears every slot
 *  that still references the handle — otherwise a later `bindTexture(unit, B)`
 *  to the same unit would be wrongly elided when slot still showed handle A. */
export function disposeTexture(engine: GLEngineContext, tex: GLTexture): void {
    if (tex._disposed) {
        return;
    }
    if (tex._refCount > 1) {
        tex._refCount--;
        return;
    }
    tex._disposed = true;
    const i = engine._textures.indexOf(tex);
    if (i !== -1) {
        engine._textures.splice(i, 1);
    }
    if (!engine._isLost && !engine._disposed) {
        engine.gl.deleteTexture(tex.handle);
    }
    const bound = engine._state.boundTextures;
    for (let u = 0; u < bound.length; u++) {
        if (bound[u] === tex.handle) {
            bound[u] = null;
        }
    }
}

/** Internal — resolve the sized internalFormat for the LDR (byte) `texImage2D`
 *  paths ONLY: RGBA→RGBA8, RGB→RGB8, RG→RG8, RED→R8, LUMINANCE passthrough.
 *  Deliberately knows nothing about FLOAT / HALF_FLOAT so the float-format table
 *  in {@link pickSizedInternalFormat} tree-shakes out of byte-only bundles.
 *  @internal */
function resolveLdrInternalFormat(gl: WebGL2RenderingContext, format: GLenum, type: GLenum): GLenum {
    if (type === gl.UNSIGNED_BYTE) {
        if (format === gl.RGBA) {
            return gl.RGBA8;
        }
        if (format === gl.RGB) {
            return gl.RGB8;
        }
        if (format === gl.RG) {
            return gl.RG8;
        }
        if (format === gl.RED) {
            return gl.R8;
        }
        if (format === gl.LUMINANCE) {
            return gl.LUMINANCE;
        }
    }
    return format;
}

/** Internal — pick a sized internalFormat for `texImage2D`. WebGL2 prefers
 *  sized formats for non-color-renderable / non-readback paths; for the
 *  NeonBrush use cases (sample-only) the unsized format works too, but sized
 *  is more portable. Shared with the render-target module.
 *  @internal */
export function pickSizedInternalFormat(gl: WebGL2RenderingContext, format: GLenum, type: GLenum): GLenum {
    if (type === gl.UNSIGNED_BYTE) {
        if (format === gl.RGBA) {
            return gl.RGBA8;
        }
        if (format === gl.RGB) {
            return gl.RGB8;
        }
        if (format === gl.LUMINANCE) {
            return gl.LUMINANCE;
        }
    }
    if (type === gl.FLOAT) {
        if (format === gl.RGBA) {
            return gl.RGBA32F;
        }
        if (format === gl.RGB) {
            return gl.RGB32F;
        }
    }
    if (type === gl.HALF_FLOAT) {
        if (format === gl.RGBA) {
            return gl.RGBA16F;
        }
        if (format === gl.RGB) {
            return gl.RGB16F;
        }
    }
    return format;
}
