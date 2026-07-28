/**
 * Babylon.js-compatible 2D **texture array** wrappers over Babylon Lite's
 * `createTexture2DArray` / `uploadImageToArrayLayer` / `loadImageToArrayLayer` /
 * `createTexture2DArrayFromUrls`.
 *
 * A texture array is a single GPU texture holding N same-size, same-format layers
 * (sampled in a shader as `texture_2d_array<f32>` with an explicit layer index).
 * Babylon.js exposes the raw-bytes constructor on `RawTexture2DArray` plus the
 * image-source helper functions in `rawTexture2DArray.functions`. Babylon Lite
 * backs the image-source path directly; the raw-bytes upload path (a full
 * multi-layer `ArrayBufferView`) has no Lite equivalent, so it throws.
 */

import { createTexture2DArray, uploadImageToArrayLayer, loadImageToArrayLayer, createTexture2DArrayFromUrls } from "babylon-lite";
import type { Texture2DArray } from "babylon-lite";

import { unsupported } from "../error.js";
import type { Scene } from "../scene/scene.js";
import { BaseTexture } from "./textures.js";

/** The decoded image sources WebGPU (and therefore Lite) can upload into a layer. */
type ImageSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement | ImageData | VideoFrame;

/**
 * Babylon.js `RawTexture2DArray` — a 2D array texture. Backed by Babylon Lite's
 * `Texture2DArray`.
 *
 * The image-source path is fully supported (construct empty with `data = null`,
 * then fill layers via {@link UploadImageToTexture2DArrayLayer} /
 * {@link LoadImageToTexture2DArrayLayerAsync}, or build in one call with
 * {@link CreateTexture2DArrayFromImageUrlsAsync}). Passing raw multi-layer pixel
 * bytes (`data !== null`), and the raw-bytes `update` / `updateMipLevel` /
 * `CreateRGBATexture` helpers, throw — Lite's array API uploads decoded image
 * sources, not raw byte buffers.
 */
export class RawTexture2DArray extends BaseTexture {
    /** @internal The underlying Lite 2D-array handle (aliases `_lite`). */
    public _liteArray: Texture2DArray | undefined;
    /** Babylon.js `RawTexture2DArray.is2DArray` — always true. */
    public readonly is2DArray = true;
    /** @internal Owning compat scene. */
    public _sceneRef: Scene;
    /** @internal Number of array layers. */
    public _layers: number;

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
        this._layers = depth;
        if (data !== null) {
            // A non-null `data` is a raw multi-layer byte buffer — Babylon Lite's array API
            // uploads decoded image sources, not raw bytes, so it cannot back this path.
            unsupported(
                "RawTexture2DArray (raw-bytes constructor)",
                "Babylon Lite's texture-array API uploads decoded image sources. Construct with `data = null` and fill layers via `UploadImageToTexture2DArrayLayer` / `CreateTexture2DArrayFromImageUrlsAsync`."
            );
        }
        const tex = createTexture2DArray(scene.getEngine()._lite, width, height, depth, { mipMaps: generateMipMaps });
        this._liteArray = tex;
        this._lite = tex;
    }

    public override getClassName(): string {
        return "RawTexture2DArray";
    }

    /** Babylon.js `RawTexture2DArray.depth` — the number of array layers. */
    public get depth(): number {
        return this._layers;
    }

    /** The scene this texture belongs to (Babylon.js `ThinTexture.getScene`). */
    public getScene(): Scene {
        return this._sceneRef;
    }

    /** Babylon.js `RawTexture2DArray.update(data)` — raw-bytes re-upload; not backable by Lite. */
    public update(_data: ArrayBufferView): never {
        return unsupported(
            "RawTexture2DArray.update",
            "Babylon Lite's texture-array API has no raw-bytes upload; upload decoded image sources with `UploadImageToTexture2DArrayLayer`."
        );
    }

    /** Babylon.js `RawTexture2DArray.updateMipLevel(data, mipLevel)` — raw-bytes upload; not backable. */
    public updateMipLevel(_data: ArrayBufferView, _mipLevel: number): never {
        return unsupported(
            "RawTexture2DArray.updateMipLevel",
            "Babylon Lite's texture-array API has no raw-bytes upload; upload decoded image sources with `UploadImageToTexture2DArrayLayer`."
        );
    }

    public override whenReadyAsync(): Promise<void> {
        return Promise.resolve();
    }

    /**
     * @internal Reconcile the image-URL construction path
     * ({@link CreateTexture2DArrayFromImageUrlsAsync}) into the single BJS-named
     * class without re-running the raw-bytes constructor.
     */
    public static _fromLite(liteArray: Texture2DArray, format: number, scene: Scene): RawTexture2DArray {
        const tex: RawTexture2DArray = Object.create(RawTexture2DArray.prototype);
        tex.name = "";
        (tex as { is2DArray: boolean }).is2DArray = true;
        tex.format = format;
        tex._sceneRef = scene;
        tex._layers = liteArray.layers;
        tex._liteArray = liteArray;
        tex._lite = liteArray;
        return tex;
    }

    /** Babylon.js `RawTexture2DArray.CreateRGBATexture` — raw-bytes factory; not backable by Lite. */
    public static CreateRGBATexture(
        _data: ArrayBufferView,
        _width: number,
        _height: number,
        _depth: number,
        _scene: Scene,
        _generateMipMaps = true,
        _invertY = false,
        _samplingMode = 3,
        _type = 0
    ): never {
        return unsupported(
            "RawTexture2DArray.CreateRGBATexture",
            "Babylon Lite's texture-array API uploads decoded image sources, not raw bytes; use `CreateTexture2DArrayFromImageUrlsAsync`."
        );
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

/** @internal Resolve the engine handle a texture-array was created against. */
function engineOf(texture: RawTexture2DArray): import("babylon-lite").EngineContext {
    return texture.getScene().getEngine()._lite;
}

/** @internal Guard that the layer index is a valid integer for the texture. */
function assertLive(texture: RawTexture2DArray): Texture2DArray {
    if (!texture._liteArray) {
        throw new Error("Cannot upload to a 2D array texture that has no internal texture.");
    }
    return texture._liteArray;
}

/**
 * Babylon.js `UploadImageToTexture2DArrayLayer` — upload a decoded image source
 * into one layer of a texture array. Forwards to Lite's `uploadImageToArrayLayer`.
 */
export function UploadImageToTexture2DArrayLayer(texture: RawTexture2DArray, source: ImageSource, layer: number, options?: IUploadImageToTexture2DArrayLayerOptions): void {
    const array = assertLive(texture);
    uploadImageToArrayLayer(engineOf(texture), array, layer, source as GPUCopyExternalImageSource, {
        invertY: options?.invertY ?? false,
        premultiplyAlpha: options?.premultiplyAlpha ?? false,
    });
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
    const array = assertLive(texture);
    await loadImageToArrayLayer(engineOf(texture), array, layer, url, {
        invertY: options?.invertY ?? false,
        premultiplyAlpha: options?.premultiplyAlpha ?? false,
    });
}

/**
 * Babylon.js `CreateTexture2DArrayFromImageUrlsAsync` — create a texture array and
 * fill each layer from a list of image URLs. Forwards to Lite's
 * `createTexture2DArrayFromUrls`, then wraps the result in a `RawTexture2DArray`.
 */
export async function CreateTexture2DArrayFromImageUrlsAsync(
    scene: Scene,
    urls: readonly [string, ...string[]],
    options?: ICreateTexture2DArrayFromImageUrlsOptions
): Promise<RawTexture2DArray> {
    const liteArray = await createTexture2DArrayFromUrls(scene.getEngine()._lite, urls, { mipMaps: options?.generateMipMaps ?? true });
    // Babylon.js defaults the format to TEXTUREFORMAT_RGBA (5).
    return RawTexture2DArray._fromLite(liteArray, 5, scene);
}
