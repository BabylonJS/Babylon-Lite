import type { GLEngineContext } from "./context.js";
import { bindTextureForUpload, disposeTexture, setBoundTextureParams, setUnpackState, type GLTexture, type GLTextureOptions } from "./texture.js";

/** Upload and sampling options for {@link createTextureFromSource}. */
export interface GLTextureSourceOptions extends Omit<GLTextureOptions, "internalFormat"> {
    /**
     * Keep the source for automatic context-restore replay. Default true.
     * With false, release the reference after upload and restore transparent
     * black at the original size instead; the caller must recreate content
     * (for example from an `onContextRestored` callback).
     */
    retainSource?: boolean;
}

/**
 * Create an immediately ready RGBA 2D texture from already-decoded pixels with
 * one source upload, no placeholder or blank pre-allocation. Sampling defaults
 * to linear filtering and clamp-to-edge wrapping; mipmaps are a separate opt-in
 * via `generateTextureMipMaps`.
 *
 * The source is retained for context restoration by default. Keep it usable
 * while the texture is live; mutable sources replay their current content and
 * intrinsic size. If a retained source has become unusable by restore time
 * (for example a closed `ImageBitmap`), the error is logged, the source is
 * dropped and the texture restores transparent black at its last uploaded size
 * so the rest of the engine still restores. With `retainSource: false`, the
 * source reference is dropped after upload and restoration creates a ready,
 * transparent-black texture at the original size; re-upload content from an
 * `onContextRestored` callback. This function never closes a bitmap or video
 * frame.
 *
 * Restoration replays level 0 and the sampling parameters only. When using a
 * mipmapped `minFilter`, call `generateTextureMipMaps` after creation and
 * again from an `onContextRestored` callback, otherwise the restored texture
 * is mipmap-incomplete and samples black.
 *
 * WebGL ignores unpack flip/premultiplication for `ImageBitmap`; select
 * `imageOrientation` / `premultiplyAlpha` when decoding those sources instead.
 *
 * The texture is immutable from the API's point of view: to change its pixels,
 * dispose it and create a new one. Do not pass it to `updateDynamicTexture`
 * (the new source would be ignored) or `updateHtmlElementTexture` (it would
 * run the context-restore replay on the live texture).
 *
 * Image elements are sized from `naturalWidth` / `naturalHeight`. For SVG
 * images and density-selected (`srcset` / `x` descriptor) images, WebGL may
 * upload a different pixel size, so the reported and restored dimensions can
 * be wrong; convert those to an `ImageBitmap` (`createImageBitmap`) first.
 *
 * @param engine - The live engine that will own the texture.
 * @param source - An ImageBitmap, ImageData (with an attached buffer), canvas,
 * OffscreenCanvas, decoded raster image, video or VideoFrame with positive
 * intrinsic dimensions.
 * @param options - Unpack and sampling overrides; defaults are invertY false,
 * premultiplyAlpha false, unpackAlignment 4 and retainSource true.
 * @returns A managed texture disposed with {@link disposeTexture}.
 * @throws If the engine is lost/disposed, dimensions exceed the texture limit
 * or are not positive integers, unpack alignment is invalid, or allocation fails.
 */
export function createTextureFromSource(engine: GLEngineContext, source: TexImageSource, options: GLTextureSourceOptions = {}): GLTexture {
    if (engine._isLost || engine._disposed) {
        throw new Error("lite-gl: cannot create a source texture on a lost or disposed engine");
    }
    const [width, height] = sourceSize(engine, source);
    const alignment = options.unpackAlignment ?? 4;
    if (alignment !== 1 && alignment !== 2 && alignment !== 4 && alignment !== 8) {
        throw new Error("lite-gl: texture unpackAlignment must be 1, 2, 4 or 8");
    }
    const gl = engine.gl;
    const minFilter = options.minFilter ?? gl.LINEAR;
    const magFilter = options.magFilter ?? gl.LINEAR;
    const wrapS = options.wrapS ?? gl.CLAMP_TO_EDGE;
    const wrapT = options.wrapT ?? gl.CLAMP_TO_EDGE;
    const invertY = options.invertY ?? false;
    const premultiplyAlpha = options.premultiplyAlpha ?? false;
    let retainedSource: TexImageSource | null = source;
    const handle = gl.createTexture();
    if (handle === null) {
        throw new Error("lite-gl: gl.createTexture returned null");
    }

    const uploadSource = (target: GLEngineContext, src: TexImageSource, w: number, h: number): void => {
        const g = target.gl;
        setUnpackState(target, invertY, premultiplyAlpha, alignment);
        bindTextureForUpload(target, tex.handle);
        g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, src);
        tex.width = w;
        tex.height = h;
    };
    // Context-restore replay. A retained source that became unusable (closed
    // bitmap, emptied video, tainted image) must not abort the engine-wide
    // restore, so fall back to transparent black at the last uploaded size.
    const restore = (target: GLEngineContext): void => {
        if (retainedSource !== null) {
            try {
                const [w, h] = sourceSize(target, retainedSource);
                uploadSource(target, retainedSource, w, h);
                return;
            } catch (err) {
                console.error("lite-gl: retained texture source unusable on restore; restored blank", err);
                retainedSource = null;
            }
        }
        const g = target.gl;
        setUnpackState(target, invertY, premultiplyAlpha, alignment);
        bindTextureForUpload(target, tex.handle);
        g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, tex.width, tex.height, 0, g.RGBA, g.UNSIGNED_BYTE, null);
    };
    const initializeParameters = (target: GLEngineContext): void => {
        setBoundTextureParams(target.gl, minFilter, magFilter, wrapS, wrapT);
    };
    const tex: GLTexture = {
        handle,
        target: gl.TEXTURE_2D,
        width,
        height,
        isReady: true,
        _disposed: false,
        _refCount: 1,
        _upload: restore,
        _initializeParameters: initializeParameters,
        _wasReady: true,
    };
    try {
        uploadSource(engine, source, width, height);
        initializeParameters(engine);
    } catch (error) {
        disposeTexture(engine, tex);
        throw error;
    }
    if (options.retainSource === false) {
        retainedSource = null;
    }
    engine._textures.add(tex);
    return tex;
}

/** Use intrinsic upload dimensions without depending on DOM constructor globals.
 *  Also rejects sources WebGL would fail on without throwing (a detached
 *  `ImageData` buffer only raises `INVALID_VALUE`), so creation throws and
 *  restore takes the blank fallback instead of marking empty storage ready. */
function sourceSize(engine: GLEngineContext, source: TexImageSource): [number, number] {
    let width: number;
    let height: number;
    if ("videoWidth" in source) {
        width = source.videoWidth;
        height = source.videoHeight;
    } else if ("naturalWidth" in source) {
        width = source.naturalWidth;
        height = source.naturalHeight;
    } else if ("displayWidth" in source) {
        width = source.displayWidth;
        height = source.displayHeight;
    } else {
        // ImageData is never zero-sized, so an empty pixel array means its buffer was transferred.
        if ("data" in source && source.data.length === 0) {
            throw new Error("lite-gl: source ImageData buffer is detached");
        }
        width = source.width;
        height = source.height;
    }
    const maxSize = engine.caps.maxTextureSize;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > maxSize || height > maxSize) {
        throw new Error(`lite-gl: source texture dimensions must be positive integers <= ${maxSize} (got ${width}x${height})`);
    }
    return [width, height];
}
