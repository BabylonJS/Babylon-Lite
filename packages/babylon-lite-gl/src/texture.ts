import type { GLEngineContext } from "./context.js";

/** Texture sampling / wrap options. All have GL-spec defaults. */
export interface GLTextureOptions {
    /** Default: false. */
    generateMipMaps?: boolean;
    /** Default: false (matches Babylon's default raw-texture behaviour). */
    invertY?: boolean;
    /** Default: gl.LINEAR. */
    minFilter?: GLenum;
    /** Default: gl.LINEAR. */
    magFilter?: GLenum;
    /** Default: gl.CLAMP_TO_EDGE. */
    wrapS?: GLenum;
    /** Default: gl.CLAMP_TO_EDGE. */
    wrapT?: GLenum;
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
}

/** Uint8 raw texture upload. */
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
    const generateMipMaps = opts.generateMipMaps ?? false;
    const internalFormat = pickSizedInternalFormat(gl, format, type);

    const upload = (target: GLEngineContext): void => {
        const g = target.gl;
        g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, invertY ? 1 : 0);
        bindTextureForUpload(target, tex.handle);
        g.texImage2D(g.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, minFilter);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, magFilter);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, wrapS);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, wrapT);
        if (generateMipMaps) {
            g.generateMipmap(g.TEXTURE_2D);
        }
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
    upload(engine);
    engine._textures.push(tex);
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
    const generateMipMaps = opts.generateMipMaps ?? false;

    let bitmap: ImageBitmap | null = null;
    const placeholderPixels = new Uint8Array([0, 0, 0, 0]);

    const upload = (target: GLEngineContext): void => {
        const g = target.gl;
        // invertY is applied at decode time via createImageBitmap({ imageOrientation })
        // because UNPACK_FLIP_Y_WEBGL is IGNORED for ImageBitmap sources (and the 1×1
        // placeholder is flip-invariant), so keep the global flip state off here.
        g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0);
        bindTextureForUpload(target, tex.handle);
        if (bitmap !== null) {
            g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, bitmap);
            if (generateMipMaps) {
                g.generateMipmap(g.TEXTURE_2D);
            }
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

/** Internal — pick a sized internalFormat for `texImage2D`. WebGL2 prefers
 *  sized formats for non-color-renderable / non-readback paths; for the
 *  NeonBrush use cases (sample-only) the unsized format works too, but sized
 *  is more portable. */
function pickSizedInternalFormat(gl: WebGL2RenderingContext, format: GLenum, type: GLenum): GLenum {
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
