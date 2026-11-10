/**
 * HTML-element textures — the Babylon Native backend of `src/html-texture.ts`,
 * with the same receiver-first API. Native has no DOM, so the "element" is a
 * Babylon Native canvas ({@link NativeCanvasSource}, blitted with
 * `COMMAND_COPYTEXTURE`) or decoded pixels ({@link NativePixelSource}). The
 * texture follows the source's size on every update.
 */
import type { GLTexture, GLTextureOptions, GLTextureUpdateOptions, TextureAllocation } from "./texture.js";
import { makeTexture, registerTexture } from "./texture.js";
import { dCreateTexture } from "./native-device.js";
import type { GLEngineContext } from "./native-context.js";
import type { NativeTextureSource } from "./native-source.js";
import { isNativeCanvasSource, isNativePixelSource, unsupportedSource, uploadNativeSource } from "./native-source.js";

/**
 * Create a texture backed by a native canvas / pixel source (≙ the WebGL
 * `createHtmlElementTexture`). The initial upload happens immediately; call
 * {@link updateHtmlElementTexture} after the source changed.
 *
 * NATIVE: `element` must be a {@link NativeCanvasSource} or
 * {@link NativePixelSource}; DOM elements throw. The DOM members of the
 * parameter type only keep WebGL-typed call sites compiling.
 *
 * @param engine - The engine to create native resources on.
 * @param element - The native source.
 * @param options - The shared {@link GLTextureOptions}.
 * @returns The new {@link GLTexture}.
 */
export function createHtmlElementTexture(
    engine: GLEngineContext,
    element: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | NativeTextureSource,
    options?: GLTextureOptions
): GLTexture {
    if (!isNativeCanvasSource(element) && !isNativePixelSource(element)) {
        unsupportedSource("createHtmlElementTexture");
    }
    const source: NativeTextureSource = element;
    const opts = options ?? {};
    const invertY = opts.invertY ?? false;
    const premultiplyAlpha = opts.premultiplyAlpha ?? false;
    let alloc: TextureAllocation | null = null;
    const tex = makeTexture(engine, dCreateTexture(engine), 1, 1, true, opts);
    const upload = (e: GLEngineContext): void => {
        alloc = uploadNativeSource(e, tex, source, tex._invertY ?? invertY, tex._premultiplyAlpha ?? premultiplyAlpha, alloc, "createHtmlElementTexture");
    };
    tex._upload = upload;
    tex._restore = (e) => {
        tex.handle = dCreateTexture(e);
        alloc = null;
        upload(e);
    };
    upload(engine);
    registerTexture(engine, tex);
    return tex;
}

/**
 * Re-upload the texture from its source (≙ the WebGL `updateHtmlElementTexture`).
 * No-op when the engine is lost/disposed or the texture is disposed.
 *
 * @param tex - A texture created by {@link createHtmlElementTexture}.
 * @param options - Per-update `invertY` / `premultiplyAlpha` (default: the
 *  creation values; not applied by canvas blits). Retained for restore replay.
 */
export function updateHtmlElementTexture(tex: GLTexture, options?: GLTextureUpdateOptions): void {
    const engine = tex._engine;
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    tex._invertY = options?.invertY;
    tex._premultiplyAlpha = options?.premultiplyAlpha;
    tex._upload(engine);
}
