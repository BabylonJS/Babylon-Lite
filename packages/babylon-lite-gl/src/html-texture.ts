/**
 * HTML element textures.
 *
 * Part of the public API via the `@babylonjs/lite-gl` barrel. The package is
 * `sideEffects: false`, so consumers that don't need it (everything except
 * NeonBrush's `InputGlow`) tree-shake it out.
 */
import type { GLEngineContext } from "./context.js";
import {
    bindTextureForUpload,
    setTexImageSourceSize,
    setBoundTextureParams,
    setUnpackState,
    type GLTexture,
    type GLTextureOptions,
    type GLTextureUpdateOptions,
} from "./texture.js";

/** Options for `createHtmlElementTexture` — the shared {@link GLTextureOptions}
 *  (including `invertY` and `premultiplyAlpha`), applied on creation, on every
 *  `updateHtmlElementTexture` and on `webglcontextrestored`. For Babylon-style
 *  presets spread `getSamplingModeFilters(...)`; for mipmaps call
 *  `generateTextureMipMaps` once and every later update rebuilds the chain. */
export type GLHtmlElementTextureOptions = GLTextureOptions;

/** Create a texture backed by an `<canvas>` / `<img>` / `<video>` element.
 *  The initial upload is performed immediately; call `updateHtmlElementTexture`
 *  to re-upload after the source has changed. */
export function createHtmlElementTexture(
    engine: GLEngineContext,
    element: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement,
    options?: GLHtmlElementTextureOptions
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
    const premultiplyAlpha = opts.premultiplyAlpha ?? false;

    const upload = (target: GLEngineContext): void => {
        const g = target.gl;
        setUnpackState(target, tex._invertY ?? invertY, tex._premultiplyAlpha ?? premultiplyAlpha);
        bindTextureForUpload(target, tex.handle);
        g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, g.RGBA, g.UNSIGNED_BYTE, element);
        setTexImageSourceSize(tex, element);
    };

    const initializeParameters = (target: GLEngineContext): void => {
        setBoundTextureParams(target.gl, minFilter, magFilter, wrapS, wrapT);
    };

    const tex: GLTexture = {
        handle,
        target: gl.TEXTURE_2D,
        width: 1,
        height: 1,
        isReady: true,
        _disposed: false,
        _refCount: 1,
        _upload: upload,
        _initializeParameters: initializeParameters,
        _wasReady: true,
    };
    upload(engine);
    initializeParameters(engine);
    engine._textures.add(tex);
    return tex;
}

/** Re-upload the texture from its source element — the counterpart of
 *  Babylon's `HtmlElementTexture.update(invertY)`. Only valid for textures
 *  created by {@link createHtmlElementTexture}. No-op when the context is
 *  lost/disposed or the texture is disposed.
 *
 *  @param engine - The engine that owns the texture.
 *  @param tex - A texture created by {@link createHtmlElementTexture}.
 *  @param options - Per-update `invertY` / `premultiplyAlpha`; each defaults to
 *   the texture's creation value. Retained for `webglcontextrestored` replay. */
export function updateHtmlElementTexture(engine: GLEngineContext, tex: GLTexture, options?: GLTextureUpdateOptions): void {
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    tex._invertY = options?.invertY;
    tex._premultiplyAlpha = options?.premultiplyAlpha;
    tex._upload(engine);
}
