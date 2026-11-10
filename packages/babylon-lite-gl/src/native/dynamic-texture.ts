/**
 * Dynamic textures — the Babylon Native backend of `src/dynamic-texture.ts`,
 * with the same receiver-first API. A dynamic texture is a blank RGBA8
 * allocation whose pixels are pushed on demand with {@link updateDynamicTexture}
 * and replayed into the fresh handle on device restore.
 *
 * NATIVE SOURCES: instead of a DOM `TexImageSource`, `source` is a Babylon
 * Native canvas ({@link NativeCanvasSource} — GPU blit via `COMMAND_COPYTEXTURE`)
 * or decoded pixels ({@link NativePixelSource} — e.g. `createImageBitmap`'s
 * result, or an `ImageData`-shaped object). As on WebGL, `tex.width` /
 * `tex.height` follow the source size. Canvas blits apply neither `invertY` nor
 * `premultiplyAlpha` and fill mip 0 only.
 */
import type { GLTexture, GLTextureOptions, GLTextureUpdateOptions, TextureAllocation } from "./texture.js";
import { makeTexture, registerTexture, uploadNativePixels } from "./texture.js";
import { dCreateTexture } from "./native-device.js";
import type { GLEngineContext } from "./native-context.js";
import type { NativeTextureSource } from "./native-source.js";
import { uploadNativeSource } from "./native-source.js";

/**
 * Create a texture backed by an empty (transparent black) `width × height`
 * RGBA8 allocation whose pixels are pushed with {@link updateDynamicTexture}
 * (≙ the WebGL `createDynamicTexture`). Device-restore-safe: the latest source
 * is replayed into the fresh handle (re-blanked if none was pushed yet).
 *
 * @param engine - The engine to create native resources on.
 * @param width - Texture width in texels (clamped to ≥ 1).
 * @param height - Texture height in texels (clamped to ≥ 1).
 * @param options - The shared {@link GLTextureOptions}; `invertY` /
 *  `premultiplyAlpha` become the defaults of every update that omits them.
 * @returns The new {@link GLTexture}.
 */
export function createDynamicTexture(engine: GLEngineContext, width: number, height: number, options?: GLTextureOptions): GLTexture {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const opts = options ?? {};
    const invertY = opts.invertY ?? false;
    const premultiplyAlpha = opts.premultiplyAlpha ?? false;
    let alloc: TextureAllocation | null = null;
    const tex = makeTexture(engine, dCreateTexture(engine), w, h, true, opts);
    tex._dynSource = null;

    const upload = (e: GLEngineContext): void => {
        const src = tex._dynSource as NativeTextureSource | null | undefined;
        if (src !== null && src !== undefined) {
            alloc = uploadNativeSource(e, tex, src, tex._invertY ?? invertY, tex._premultiplyAlpha ?? premultiplyAlpha, alloc, "updateDynamicTexture");
        } else {
            alloc = uploadNativePixels(e, tex, new Uint8Array(w * h * 4), w, h, _native.Engine.TEXTURE_FORMAT_RGBA8, false, alloc);
        }
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
 * Push pixels into a {@link createDynamicTexture} texture (≙ the WebGL
 * `updateDynamicTexture`). The source is retained for device-restore replay and
 * `tex.width` / `tex.height` follow its size. No-op when the engine is
 * lost/disposed or the texture is disposed.
 *
 * NATIVE: `source` must be a {@link NativeCanvasSource} or {@link NativePixelSource};
 * DOM sources throw. The `TexImageSource` member of the parameter type only
 * keeps WebGL-typed call sites compiling.
 *
 * @param tex - A texture created by {@link createDynamicTexture}.
 * @param source - The native pixel source to upload.
 * @param options - Per-update `invertY` / `premultiplyAlpha` (default: the
 *  creation values). Not applied by canvas blits.
 */
export function updateDynamicTexture(tex: GLTexture, source: TexImageSource | NativeTextureSource, options?: GLTextureUpdateOptions): void {
    const engine = tex._engine;
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    tex._dynSource = source;
    tex._invertY = options?.invertY;
    tex._premultiplyAlpha = options?.premultiplyAlpha;
    tex._upload(engine);
}

/**
 * Forget the source a dynamic texture retained for device-restore replay (≙ the
 * WebGL `clearDynamicTextureSource`). The current GPU pixels are kept; a later
 * device restore re-blanks the texture instead of replaying. No device call.
 *
 * @param tex - A texture created by {@link createDynamicTexture}.
 */
export function clearDynamicTextureSource(tex: GLTexture): void {
    tex._dynSource = null;
}
