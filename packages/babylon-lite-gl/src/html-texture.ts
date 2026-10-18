/**
 * HTML element textures.
 *
 * Part of the public API via the `@babylonjs/lite-gl` barrel. The package is
 * `sideEffects: false`, so consumers that don't need it (everything except
 * NeonBrush's `InputGlow`) tree-shake it out.
 */
import type { GLEngineContext } from "./context.js";
import { bindTextureForUpload, resolveTextureOptions, setTexImageSourceSize, setBoundTextureParams, setUnpackState, type GLTexture, type GLTextureOptions } from "./texture.js";

/** Options for `createHtmlElementTexture` — the shared {@link GLTextureOptions}
 *  (including `samplingMode`, `generateMipMaps`, `invertY` and
 *  `premultiplyAlpha`), applied on creation, on every
 *  `updateHtmlElementTexture` and on `webglcontextrestored`. */
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
    const [minFilter, magFilter, wrapS, wrapT, generateMipMaps, invertY, premultiplyAlpha] = resolveTextureOptions(gl, options);

    const upload = (target: GLEngineContext): void => {
        const g = target.gl;
        setUnpackState(target, invertY, premultiplyAlpha);
        bindTextureForUpload(target, tex.handle);
        g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, g.RGBA, g.UNSIGNED_BYTE, element);
        setTexImageSourceSize(tex, element);
        if (tex._useMipMaps) {
            g.generateMipmap(g.TEXTURE_2D);
        }
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
        _useMipMaps: generateMipMaps,
    };
    upload(engine);
    initializeParameters(engine);
    engine._textures.add(tex);
    return tex;
}

/** Re-upload the texture from its source element. Only valid for textures
 *  created by {@link createHtmlElementTexture}. No-op when the context is
 *  lost/disposed or the texture is disposed. */
export function updateHtmlElementTexture(engine: GLEngineContext, tex: GLTexture): void {
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    tex._upload(engine);
}
