/**
 * Dynamic (canvas-/bitmap-backed) textures.
 *
 * Part of the public API via the `@babylonjs/lite-gl` barrel. The package is
 * `sideEffects: false`, so consumers that never push 2D pixel sources into a
 * texture tree-shake this code out.
 *
 * The WebGL counterpart of Babylon's `ThinEngine.createDynamicTexture` +
 * `updateDynamicTexture`. A dynamic texture is a blank RGBA8 allocation whose
 * pixels are pushed on demand from a canvas / `OffscreenCanvas` / image / video
 * / `ImageBitmap` / `ImageData` source. The most recent source is retained
 * internally and replayed into the fresh handle on `webglcontextrestored` by the
 * engine's standard context-restore protocol.
 */
import { bindTextureForUpload, getTexImageSourceSize, resolveTextureOptions, setBoundTextureParams, setUnpackState, type GLTexture, type GLTextureOptions } from "./texture.js";
import type { GLEngineContext } from "./context.js";

/** Options for {@link createDynamicTexture}: the shared {@link GLTextureOptions}
 *  (`invertY` / `premultiplyAlpha` become the defaults of every
 *  {@link updateDynamicTexture} call that omits them; `generateMipMaps`
 *  regenerates the chain after each update that carries a source). */
export type GLDynamicTextureOptions = GLTextureOptions;

/** Create a texture backed by an empty (blank) `width × height` RGBA8
 *  allocation, whose pixels are pushed on demand with
 *  {@link updateDynamicTexture} — the WebGL counterpart of Babylon's
 *  `ThinEngine.createDynamicTexture` + `ThinTexture` wrapper.
 *
 *  The texture is immediately sampleable (reads as transparent black until the
 *  first update). It is context-restore-safe: the most recent source pushed via
 *  {@link updateDynamicTexture} is replayed into the fresh handle on
 *  `webglcontextrestored` (and re-blanked if no update happened yet).
 *
 *  @param engine - The engine to create GL resources on.
 *  @param width - Texture width in texels (clamped to ≥ 1).
 *  @param height - Texture height in texels (clamped to ≥ 1).
 *  @param options - See {@link GLDynamicTextureOptions}.
 *  @returns The new {@link GLTexture}. */
export function createDynamicTexture(engine: GLEngineContext, width: number, height: number, options?: GLDynamicTextureOptions): GLTexture {
    const gl = engine.gl;
    const handle = gl.createTexture();
    if (handle === null) {
        throw new Error("lite-gl: gl.createTexture returned null");
    }
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const [minFilter, magFilter, wrapS, wrapT, generateMipMaps, invertY, premultiplyAlpha] = resolveTextureOptions(gl, options);

    // Single `_upload` closure used for both the initial allocation AND every
    // `webglcontextrestored` replay AND every `updateDynamicTexture`. The pixel
    // upload runs every time; the four `texParameteri` calls run ONLY when the
    // handle changed (initial create + restore install a fresh, GL-default
    // handle) — a per-frame pixel update keeps the same handle, whose filter/wrap
    // GL retains, so re-applying them would be a pure redundant cost.
    const upload = (target: GLEngineContext): void => {
        const g = target.gl;
        bindTextureForUpload(target, tex.handle);
        const src = tex._dynSource;
        if (src !== null && src !== undefined) {
            setUnpackState(target, tex._dynInvertY ?? invertY, tex._dynPremultiplyAlpha ?? premultiplyAlpha);
            g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, src);
            // `texImage2D(source)` resizes the GL storage to the source size.
            [tex.width, tex.height] = getTexImageSourceSize(src);
            if (generateMipMaps) {
                g.generateMipmap(g.TEXTURE_2D);
            }
        } else {
            setUnpackState(target, false, false);
            g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, null);
            tex.width = w;
            tex.height = h;
        }
        if (tex._dynParamsHandle !== tex.handle) {
            setBoundTextureParams(g, minFilter, magFilter, wrapS, wrapT);
            tex._dynParamsHandle = tex.handle;
        }
    };

    const tex: GLTexture = {
        handle,
        target: gl.TEXTURE_2D,
        width: w,
        height: h,
        isReady: true,
        _disposed: false,
        _refCount: 1,
        _upload: upload,
        _wasReady: true,
        _dynSource: null,
    };
    upload(engine);
    engine._textures.add(tex);
    return tex;
}

/** Push 2D pixels into a {@link createDynamicTexture} texture from a canvas /
 *  `OffscreenCanvas` / image / video / `ImageBitmap` / `ImageData` source — the
 *  WebGL counterpart of Babylon's `ThinEngine.updateDynamicTexture`. The source
 *  is retained on the texture so it is replayed on `webglcontextrestored`, and
 *  `tex.width` / `tex.height` follow the source's size (`texImage2D` resizes
 *  the storage). No-op when the context is lost/disposed or the texture is
 *  disposed.
 *
 *  @param engine - The engine that owns the texture.
 *  @param tex - A texture created by {@link createDynamicTexture}.
 *  @param source - The 2D pixel source to upload.
 *  @param invertY - Flip vertically on upload (`UNPACK_FLIP_Y_WEBGL`). Defaults
 *   to the texture's creation `invertY` (like Babylon's `texture.invertY`
 *   fallback), itself `false` by default.
 *  @param premultiplyAlpha - Premultiply on upload (`UNPACK_PREMULTIPLY_ALPHA_WEBGL`).
 *   Defaults to the texture's creation `premultiplyAlpha`, itself `false` by default. */
export function updateDynamicTexture(engine: GLEngineContext, tex: GLTexture, source: TexImageSource, invertY?: boolean, premultiplyAlpha?: boolean): void {
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    tex._dynSource = source;
    tex._dynInvertY = invertY;
    tex._dynPremultiplyAlpha = premultiplyAlpha;
    tex._upload(engine);
}

/** Forget the source a dynamic texture retained for context-restore replay.
 *  The current GPU pixels are kept (no re-upload), but the source reference is
 *  dropped so it can be garbage-collected — and a subsequent
 *  `webglcontextrestored` will re-blank the texture instead of replaying. Use
 *  after the final {@link updateDynamicTexture} once the source (e.g. a large
 *  atlas canvas) is no longer needed. No-op on a non-dynamic texture.
 *
 *  @param engine - The engine that owns the texture (taken for API consistency
 *   with every other texture function; no GL call is made).
 *  @param tex - A texture created by {@link createDynamicTexture}. */
export function clearDynamicTextureSource(engine: GLEngineContext, tex: GLTexture): void {
    void engine;
    tex._dynSource = null;
}
