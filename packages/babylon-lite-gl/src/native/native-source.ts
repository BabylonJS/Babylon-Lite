/**
 * Texture SOURCES the Babylon Native backend can upload — the native stand-ins
 * for the DOM `TexImageSource` / `HTMLCanvasElement` sources the WebGL backend
 * passes to `texImage2D`. Native has no DOM, so two structural source kinds are
 * supported:
 *
 * - {@link NativeCanvasSource}: a Babylon Native canvas (`@babylonjs/native`
 *   `NativeCanvas`) — its backing GPU texture is blitted with
 *   `COMMAND_COPYTEXTURE` (≙ `ThinNativeEngine.updateDynamicTexture`).
 * - {@link NativePixelSource}: decoded pixels — the result of
 *   `_native.Engine#createImageBitmap`, or any `ImageData`-shaped
 *   `{ data, width, height }` — uploaded with `loadRawTexture`.
 *
 * Shared by the dynamic-texture, HTML-element-texture and texture-source
 * modules. Kept structural so the backend carries no `@babylonjs/core` or DOM
 * dependency.
 */
import type { GLEngineContext } from "./native-context.js";
import type { NativeTexture } from "./native-types.js";
import type { GLTexture, TextureAllocation } from "./texture.js";
import { uploadNativePixels } from "./texture.js";
import { dCopyTexture, dGetTextureHeight, dGetTextureWidth } from "./native-device.js";
import { premultiplyRgba8 } from "./pixel-convert.js";

/**
 * Structural shape of a Babylon Native canvas usable as a texture source. Its
 * backing GPU texture ({@link getCanvasTexture}) is copied into the destination
 * via `COMMAND_COPYTEXTURE`, so `invertY` / `premultiplyAlpha` do not apply and
 * no mip chain is produced.
 */
export interface NativeCanvasSource {
    /** The canvas's rendering context. Its `flush()` (when present) is called
     *  before {@link getCanvasTexture} so the host materializes the backing
     *  render target first — matching `ThinNativeEngine.updateDynamicTexture`. */
    getContext(contextType?: string): { flush?: () => void } | null | undefined;
    /** The native texture handle backing the canvas — the `COPYTEXTURE` source. */
    getCanvasTexture(): NativeTexture;
}

/**
 * Decoded pixels usable as a texture source: the object returned by
 * `_native.Engine#createImageBitmap(arrayBuffer)` or any `ImageData`-shaped
 * `{ data, width, height }` (tightly packed rows, top row first).
 */
export interface NativePixelSource {
    /** Tightly packed pixel bytes in `format` (RGBA8 when omitted). */
    readonly data: ArrayBufferView;
    /** Width in texels. */
    readonly width: number;
    /** Height in texels. */
    readonly height: number;
    /** Native `TEXTURE_FORMAT_*` of `data` (set by `createImageBitmap`). Default RGBA8. */
    readonly format?: number;
}

/** Any texture source the native backend can upload. */
export type NativeTextureSource = NativeCanvasSource | NativePixelSource;

/** True when `source` is a Babylon Native canvas. @internal */
export function isNativeCanvasSource(source: unknown): source is NativeCanvasSource {
    return typeof source === "object" && source !== null && typeof (source as NativeCanvasSource).getCanvasTexture === "function";
}

/** True when `source` carries decoded pixels. @internal */
export function isNativePixelSource(source: unknown): source is NativePixelSource {
    if (typeof source !== "object" || source === null) {
        return false;
    }
    const s = source as NativePixelSource;
    return ArrayBuffer.isView(s.data) && typeof s.width === "number" && typeof s.height === "number";
}

/** Throw the shared "unsupported source" error. @internal */
export function unsupportedSource(fn: string): never {
    throw new Error(
        `lite-gl: ${fn} on Babylon Native needs a NativeCanvasSource (getCanvasTexture) or decoded pixels ({ data, width, height }, e.g. from createImageBitmap); DOM sources are not supported`
    );
}

/** The size `source` uploads at (≥ 1). @internal */
export function nativeSourceSize(engine: GLEngineContext, source: NativeTextureSource): [number, number] {
    if (isNativeCanvasSource(source)) {
        source.getContext()?.flush?.();
        const handle = source.getCanvasTexture();
        return [dGetTextureWidth(engine, handle) || 1, dGetTextureHeight(engine, handle) || 1];
    }
    return [source.width, source.height];
}

/**
 * Upload `source` into `tex` (re-creating the handle when the size / format /
 * mip intent changed since `alloc`), updating `tex.width` / `tex.height` to the
 * source size. Pixel sources honour `invertY` (host flip) and `premultiplyAlpha`
 * (CPU, RGBA8 only) and the texture's mip intent; canvas sources are a GPU blit
 * that applies neither flag and fills mip 0 only (so they are allocated without
 * mips). Returns the new allocation record.
 * @internal
 */
export function uploadNativeSource(
    engine: GLEngineContext,
    tex: GLTexture,
    source: NativeTextureSource,
    invertY: boolean,
    premultiplyAlpha: boolean,
    alloc: TextureAllocation | null,
    fn: string
): TextureAllocation {
    const rgba8 = _native.Engine.TEXTURE_FORMAT_RGBA8;
    if (isNativeCanvasSource(source)) {
        source.getContext()?.flush?.();
        const src = source.getCanvasTexture();
        const w = dGetTextureWidth(engine, src) || 1;
        const h = dGetTextureHeight(engine, src) || 1;
        let next = alloc;
        if (next === null || next.width !== w || next.height !== h || next.format !== rgba8 || next.mips) {
            // COLD PATH: (re)allocate a zeroed RGBA8 destination — the proven-valid
            // COPYTEXTURE target (≙ ThinNativeEngine.createDynamicTexture).
            const hasMips = tex._hasMipMaps;
            tex._hasMipMaps = false;
            next = uploadNativePixels(engine, tex, new Uint8Array(w * h * 4), w, h, rgba8, false, alloc);
            tex._hasMipMaps = hasMips;
        }
        dCopyTexture(engine, src, tex.handle);
        return next;
    }
    if (!isNativePixelSource(source)) {
        unsupportedSource(fn);
    }
    const format = source.format ?? rgba8;
    let data: ArrayBufferView = source.data;
    if (premultiplyAlpha && format === rgba8) {
        const copy = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
        premultiplyRgba8(copy);
        data = copy;
    } else if (!(data instanceof Uint8Array)) {
        // loadRawTexture takes a TypedArray; normalize e.g. Uint8ClampedArray / DataView.
        data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return uploadNativePixels(engine, tex, data, source.width, source.height, format, invertY, alloc);
}
