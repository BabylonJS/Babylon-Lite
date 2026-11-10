/**
 * One-shot source textures — the Babylon Native backend of `src/texture-source.ts`.
 * Sources are native ({@link NativeCanvasSource} / {@link NativePixelSource},
 * e.g. the result of `_native.Engine#createImageBitmap`) instead of DOM
 * `TexImageSource`s.
 */
import type { GLTextureSourceOptions } from "../texture-source.js";
import type { GLEngineContext } from "./native-context.js";
import type { GLTexture, TextureAllocation } from "./texture.js";
import { disposeTexture, makeTexture, registerTexture, uploadNativePixels } from "./texture.js";
import { dCreateTexture } from "./native-device.js";
import type { NativeTextureSource } from "./native-source.js";
import { isNativeCanvasSource, isNativePixelSource, nativeSourceSize, unsupportedSource, uploadNativeSource } from "./native-source.js";

export type { GLTextureSourceOptions } from "../texture-source.js";

/**
 * Create an immediately ready RGBA texture from already-decoded pixels with a
 * single upload (≙ the WebGL `createTextureFromSource`). The source is retained
 * for device-restore replay by default; with `retainSource: false` (or if the
 * retained source fails on restore) the texture restores as transparent black
 * at its last size. Mipmaps are opt-in via `generateTextureMipMaps` (pixel
 * sources only — a canvas blit fills mip 0 only).
 *
 * NATIVE: `source` must be a {@link NativePixelSource} (e.g.
 * `engine._engine.createImageBitmap(bytes)` or an `ImageData`-shaped object) or
 * a {@link NativeCanvasSource}; DOM sources throw. `unpackAlignment` is
 * validated but pixel sources are always tightly packed.
 *
 * @param engine - The live engine that will own the texture.
 * @param source - The native pixel / canvas source.
 * @param options - Upload and sampling overrides (invertY false,
 *  premultiplyAlpha false, unpackAlignment 4, retainSource true).
 * @returns A managed texture disposed with `disposeTexture`.
 * @throws If the engine is lost/disposed, the source is unsupported, its
 *  dimensions are not positive integers within `caps.maxTextureSize`, or the
 *  unpack alignment is invalid.
 */
export function createTextureFromSource(engine: GLEngineContext, source: TexImageSource | NativeTextureSource, options: GLTextureSourceOptions = {}): GLTexture {
    if (engine._isLost || engine._disposed) {
        throw new Error("lite-gl: cannot create a source texture on a lost or disposed engine");
    }
    if (!isNativeCanvasSource(source) && !isNativePixelSource(source)) {
        unsupportedSource("createTextureFromSource");
    }
    const src: NativeTextureSource = source;
    const [width, height] = nativeSourceSize(engine, src);
    const maxSize = engine.caps.maxTextureSize;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > maxSize || height > maxSize) {
        throw new Error(`lite-gl: source texture dimensions must be positive integers <= ${maxSize} (got ${width}x${height})`);
    }
    const alignment = options.unpackAlignment ?? 4;
    if (alignment !== 1 && alignment !== 2 && alignment !== 4 && alignment !== 8) {
        throw new Error("lite-gl: texture unpackAlignment must be 1, 2, 4 or 8");
    }
    const invertY = options.invertY ?? false;
    const premultiplyAlpha = options.premultiplyAlpha ?? false;
    let retained: NativeTextureSource | null = src;
    let alloc: TextureAllocation | null = null;
    const tex = makeTexture(engine, dCreateTexture(engine), width, height, true, options);

    const upload = (e: GLEngineContext): void => {
        if (retained !== null) {
            try {
                alloc = uploadNativeSource(e, tex, retained, invertY, premultiplyAlpha, alloc, "createTextureFromSource");
                return;
            } catch (err) {
                console.error("lite-gl: retained texture source unusable on restore; restored blank", err);
                retained = null;
            }
        }
        alloc = uploadNativePixels(e, tex, new Uint8Array(tex.width * tex.height * 4), tex.width, tex.height, _native.Engine.TEXTURE_FORMAT_RGBA8, false, alloc);
    };
    tex._upload = upload;
    tex._restore = (e) => {
        tex.handle = dCreateTexture(e);
        alloc = null;
        upload(e);
    };
    try {
        alloc = uploadNativeSource(engine, tex, src, invertY, premultiplyAlpha, null, "createTextureFromSource");
    } catch (error) {
        disposeTexture(tex);
        throw error;
    }
    if (options.retainSource === false) {
        retained = null;
    }
    registerTexture(engine, tex);
    return tex;
}
