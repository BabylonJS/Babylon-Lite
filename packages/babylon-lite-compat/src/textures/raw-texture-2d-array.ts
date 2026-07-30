/**
 * Babylon.js-compatible 2D **texture array** wrappers over Babylon Lite's
 * `createTexture2DArray` / `createTexture2DArrayFromPixels` /
 * `updateTexture2DArrayFromPixels` / `uploadImageToArrayLayer` /
 * `loadImageToArrayLayer` / `createTexture2DArrayFromUrls` /
 * `loadKtx2Texture2DArray` / `uploadKtx2Texture2DArray`.
 *
 * A texture array is a single GPU texture holding N same-size, same-format layers
 * (sampled in a shader as `texture_2d_array<f32>` with an explicit layer index).
 * Babylon.js exposes the raw-bytes constructor on `RawTexture2DArray` plus the
 * image-source helper functions in `rawTexture2DArray.functions`. Both paths are
 * backed by Babylon Lite: raw multi-layer bytes go through Lite's pixel upload,
 * decoded image sources through Lite's external-image copy.
 */

import {
    createTexture2DArray,
    createTexture2DArrayFromPixels,
    updateTexture2DArrayFromPixels,
    loadImageToArrayLayer,
    createTexture2DArrayFromUrls,
    loadKtx2Texture2DArray,
    uploadKtx2Texture2DArray,
    getOrCreateSampler,
} from "babylon-lite";
import type { EngineContext, Texture2DArray } from "babylon-lite";

import { Constants } from "../misc/engine-constants.js";
import type { Scene } from "../scene/scene.js";
import { BaseTexture, toRgbaBytes } from "./textures.js";

/** The decoded image sources WebGPU (and therefore Lite) can upload into a layer. */
type ImageSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement | ImageData | VideoFrame;

/**
 * Babylon.js `RawTexture2DArray` — a 2D array texture. Backed by Babylon Lite's
 * `Texture2DArray`.
 *
 * Both Babylon.js construction paths work: pass raw multi-layer RGBA8 bytes
 * (`data !== null`) for a CPU-generated array, or construct empty (`data = null`)
 * and fill layers from decoded image sources via
 * {@link UploadImageToTexture2DArrayLayer} /
 * {@link LoadImageToTexture2DArrayLayerAsync}, or build the whole array in one call
 * with {@link CreateTexture2DArrayFromImageUrlsAsync}.
 *
 * Babylon Lite's array path is RGBA8-only, so `format` / `textureType` /
 * `samplingMode` are recorded for API parity but the upload always treats `data` as
 * tightly-packed `width * height * depth * 4` RGBA bytes (layer-major). Raw-byte
 * uploads are not Y-flipped (matching the compat `RawTexture` / `RawTexture3D`
 * pixel paths), so `invertY` is recorded but not applied to `data`.
 */
export class RawTexture2DArray extends BaseTexture {
    /** @internal The underlying Lite 2D-array handle (aliases `_lite`). */
    public _liteArray: Texture2DArray | undefined;
    /** Babylon.js `RawTexture2DArray.is2DArray` — always true. */
    public readonly is2DArray = true;
    /** @internal Owning compat scene. */
    public _sceneRef: Scene;

    public constructor(
        data: ArrayBufferView | null,
        width: number,
        height: number,
        depth: number,
        /** Babylon.js texture format (recorded for parity; Lite uploads RGBA8). */
        public format: number,
        scene: Scene,
        generateMipMaps = true,
        _invertY = false,
        _samplingMode = 3,
        _textureType?: number,
        _creationFlags?: number,
        _mipLevelCount?: number
    ) {
        super();
        this._sceneRef = scene;
        const engine = scene.getEngine()._lite;
        const tex =
            data === null
                ? createTexture2DArray(engine, width, height, depth, { mipMaps: generateMipMaps })
                : createTexture2DArrayFromPixels(engine, toRgbaBytes(data, width, height, depth), width, height, depth, { mipMaps: generateMipMaps });
        this._liteArray = tex;
        this._lite = tex;
    }

    public override getClassName(): string {
        return "RawTexture2DArray";
    }

    /** Babylon.js `RawTexture2DArray.depth` — the number of array layers. */
    public get depth(): number {
        return this._liteArray?.layers ?? 0;
    }

    /** The scene this texture belongs to (Babylon.js `ThinTexture.getScene`). */
    public getScene(): Scene {
        return this._sceneRef;
    }

    /**
     * Babylon.js `RawTexture2DArray.getInternalTexture()` — the backend handle the compat
     * engine's texture methods accept (Lite's `Texture2DArray`).
     */
    public override getInternalTexture(): Texture2DArray | null {
        return this._liteArray ?? null;
    }

    /** Babylon.js `RawTexture2DArray.update(data)` — replace the base mip of every layer. */
    public update(data: ArrayBufferView): void {
        this.updateMipLevel(data, 0);
    }

    /**
     * Babylon.js `RawTexture2DArray.updateMipLevel(data, mipLevel)` — replace one mip level of
     * every layer. Level dimensions are `max(1, size >> mipLevel)`; writing level 0 of a
     * mipmapped array regenerates the rest of the chain, exactly as Babylon.js does.
     */
    public updateMipLevel(data: ArrayBufferView, mipLevel: number): void {
        const array = this._liteArray;
        if (!array) {
            return;
        }
        const width = Math.max(1, array.width >> mipLevel);
        const height = Math.max(1, array.height >> mipLevel);
        updateTexture2DArrayFromPixels(this._sceneRef.getEngine()._lite, array, toRgbaBytes(data, width, height, array.layers), mipLevel);
    }

    public override whenReadyAsync(): Promise<void> {
        return Promise.resolve();
    }

    /**
     * @internal Reconcile the image-URL construction path
     * ({@link CreateTexture2DArrayFromImageUrlsAsync}) into the single BJS-named
     * class without re-running the allocating constructor.
     */
    public static _fromLite(liteArray: Texture2DArray, format: number, scene: Scene): RawTexture2DArray {
        const tex: RawTexture2DArray = Object.create(RawTexture2DArray.prototype);
        tex.name = "";
        (tex as { is2DArray: boolean }).is2DArray = true;
        tex.format = format;
        tex._sceneRef = scene;
        tex._liteArray = liteArray;
        tex._lite = liteArray;
        return tex;
    }

    /** Babylon.js `RawTexture2DArray.CreateRGBATexture` — RGBA raw-bytes factory. */
    public static CreateRGBATexture(
        data: ArrayBufferView,
        width: number,
        height: number,
        depth: number,
        scene: Scene,
        generateMipMaps = true,
        invertY = false,
        samplingMode = Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
        type = Constants.TEXTURETYPE_UNSIGNED_BYTE
    ): RawTexture2DArray {
        return new RawTexture2DArray(data, width, height, depth, Constants.TEXTUREFORMAT_RGBA, scene, generateMipMaps, invertY, samplingMode, type);
    }
}

/** Babylon.js `IUploadImageToTexture2DArrayLayerOptions`. */
export interface IUploadImageToTexture2DArrayLayerOptions {
    /** Store the source with the Y axis inverted (false by default). */
    invertY?: boolean;
    /** Premultiply the source alpha (false by default). */
    premultiplyAlpha?: boolean;
}

/** Babylon.js `ICreateTexture2DArrayFromImageUrlsOptions`. */
export interface ICreateTexture2DArrayFromImageUrlsOptions extends IUploadImageToTexture2DArrayLayerOptions {
    /** Generate a full mip chain (true by default). */
    generateMipMaps?: boolean;
    /** Sampling mode (recorded for parity; Lite uses trilinear). */
    samplingMode?: number;
    /** Texture type (recorded for parity; Lite uploads RGBA8). */
    textureType?: number;
    /** Options forwarded to `createImageBitmap` (recorded for parity). */
    imageBitmapOptions?: ImageBitmapOptions;
}

/** @internal Resolve the live Lite array handle a compat texture wraps. */
function liteArrayOf(texture: RawTexture2DArray): Texture2DArray {
    const array = texture.getInternalTexture();
    if (!array) {
        throw new Error("Cannot upload to a 2D array texture that has no internal texture.");
    }
    return array;
}

/**
 * Babylon.js `UploadImageToTexture2DArrayLayer` — upload a decoded image source
 * into one layer of a texture array. Routes through the engine's
 * `updateTextureArrayLayerFromImageSource` (as Babylon.js does), which forwards to
 * Lite's `uploadImageToArrayLayer`.
 */
export function UploadImageToTexture2DArrayLayer(texture: RawTexture2DArray, source: ImageSource, layer: number, options?: IUploadImageToTexture2DArrayLayerOptions): void {
    const array = liteArrayOf(texture);
    if (!Number.isInteger(layer) || layer < 0 || layer >= texture.depth) {
        throw new Error(`Layer ${layer} is out of range for a 2D array texture with ${texture.depth} layers.`);
    }
    texture
        .getScene()
        .getEngine()
        .updateTextureArrayLayerFromImageSource(array, source as GPUCopyExternalImageSource, layer, options?.invertY ?? false, options?.premultiplyAlpha ?? false);
}

/**
 * Babylon.js `LoadImageToTexture2DArrayLayerAsync` — fetch/decode an image URL and
 * upload it into one layer. Forwards to Lite's `loadImageToArrayLayer`.
 */
export async function LoadImageToTexture2DArrayLayerAsync(
    texture: RawTexture2DArray,
    url: string,
    layer: number,
    options?: IUploadImageToTexture2DArrayLayerOptions
): Promise<void> {
    const array = liteArrayOf(texture);
    await loadImageToArrayLayer(texture.getScene().getEngine()._lite, array, layer, url, {
        invertY: options?.invertY ?? false,
        premultiplyAlpha: options?.premultiplyAlpha ?? false,
    });
}

/**
 * Babylon.js `CreateTexture2DArrayFromImageUrlsAsync` — create a texture array and
 * fill each layer from a list of image URLs. Forwards to Lite's
 * `createTexture2DArrayFromUrls`, then wraps the result in a `RawTexture2DArray`.
 *
 * Lite's per-layer upload defaults to `invertY = true` (the Babylon.js *material*
 * convention); the Babylon.js helper defaults to `false`, so the flag is always
 * passed explicitly rather than left to the Lite default.
 */
export async function CreateTexture2DArrayFromImageUrlsAsync(
    scene: Scene,
    urls: readonly [string, ...string[]],
    options?: ICreateTexture2DArrayFromImageUrlsOptions
): Promise<RawTexture2DArray> {
    const liteArray = await createTexture2DArrayFromUrls(scene.getEngine()._lite, urls, {
        mipMaps: options?.generateMipMaps ?? true,
        invertY: options?.invertY ?? false,
        premultiplyAlpha: options?.premultiplyAlpha ?? false,
    });
    return RawTexture2DArray._fromLite(liteArray, Constants.TEXTUREFORMAT_RGBA, scene);
}

/** Babylon.js `ICreateTexture2DArrayFromKTX2Options` (BJS 9.17 `rawTexture2DArray.functions`). */
export interface ICreateTexture2DArrayFromKTX2Options {
    /** Defines if mip levels should be generated (true by default). */
    generateMipMaps?: boolean;
    /** Defines the sampling mode to use (`Texture.TRILINEAR_SAMPLINGMODE` by default). */
    samplingMode?: number;
    /** Defines if the texture must be stored with the Y axis inverted (false by default). */
    invertY?: boolean;
}

/** @internal Copy exactly one `ArrayBufferView` window into an owned `ArrayBuffer`. */
function copyViewToArrayBuffer(data: ArrayBufferView): ArrayBuffer {
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return copy.buffer;
}

/** @internal Apply the BJS-facing orientation and basic sampling options to a decoded Lite array. */
function applyKtx2Options(engine: EngineContext, texture: Texture2DArray, options?: ICreateTexture2DArrayFromKTX2Options): void {
    // Lite marks unflipped codec data as `invertY = true`; expose the BJS helper's
    // requested convention instead (false by default).
    texture.invertY = options?.invertY ?? false;

    const samplingMode = options?.samplingMode ?? Constants.TEXTURE_TRILINEAR_SAMPLINGMODE;
    if (samplingMode === Constants.TEXTURE_TRILINEAR_SAMPLINGMODE) {
        return;
    }

    const nearest = samplingMode === Constants.TEXTURE_NEAREST_SAMPLINGMODE;
    texture.sampler = getOrCreateSampler(engine, {
        addressModeU: "repeat",
        addressModeV: "repeat",
        minFilter: nearest ? "nearest" : "linear",
        magFilter: nearest ? "nearest" : "linear",
        mipmapFilter: "nearest",
    });
}

/**
 * Babylon.js `CreateTexture2DArrayFromKTX2Async` — decode a single multi-layer KTX2
 * container (multiple array layers) into a 2D array texture.
 *
 * Routes URLs through Lite's `loadKtx2Texture2DArray` and in-memory views through
 * `uploadKtx2Texture2DArray`, then wraps the resulting `Texture2DArray`. Lite keeps
 * the container's authored mip chain (and GPU compression where available), so the
 * `generateMipMaps` option is accepted for API shape but does not replace that chain.
 */
export async function CreateTexture2DArrayFromKTX2Async(scene: Scene, data: string | ArrayBufferView, options?: ICreateTexture2DArrayFromKTX2Options): Promise<RawTexture2DArray> {
    const engine = scene.getEngine()._lite;
    const liteArray = typeof data === "string" ? await loadKtx2Texture2DArray(engine, data) : await uploadKtx2Texture2DArray(engine, copyViewToArrayBuffer(data));
    applyKtx2Options(engine, liteArray, options);
    return RawTexture2DArray._fromLite(liteArray, Constants.TEXTUREFORMAT_RGBA, scene);
}
