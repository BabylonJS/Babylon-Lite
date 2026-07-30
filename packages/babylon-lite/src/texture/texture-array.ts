/**
 * 2D texture arrays — the WebGPU-native analog of Babylon.js `RawTexture2DArray`.
 *
 * A texture array is a single GPU texture holding N same-size, same-format
 * layers, sampled in WGSL as `texture_2d_array<f32>` with an explicit integer
 * layer index. This module is the missing convenience layer called out in the
 * forum (populating a texture array directly from image assets): it lets an
 * application create an array and fill individual layers from any WebGPU
 * external-image source — `ImageBitmap`, `ImageData`, a canvas, or a video —
 * without the "draw to an offscreen canvas and read back raw bytes" dance.
 * {@link loadKtx2Texture2DArray} covers the other shape: every layer already
 * packed into one GPU-compressed `.ktx2` container.
 *
 * The whole feature is a set of free functions with zero module-level side
 * effects, so an app that never touches texture arrays strips it entirely, and
 * an app that already holds an `ImageBitmap` never bundles the URL-fetch path.
 * Layers can be filled from decoded image sources
 * ({@link uploadImageToArrayLayer} / {@link loadImageToArrayLayer} /
 * {@link createTexture2DArrayFromUrls}) or from raw CPU-generated RGBA8 bytes
 * ({@link createTexture2DArrayFromPixels} / {@link updateTexture2DArrayFromPixels}).
 *
 * There is no built-in material that samples an array layer, so consuming a
 * `Texture2DArray` means sampling it from your own WGSL: declare a sampler with
 * `viewDimension: "2d-array"` on a {@link createShaderMaterial | ShaderMaterial}
 * (which emits a `texture_2d_array<f32>` binding) and sample it with an explicit
 * integer layer index. `StandardMaterial`/`PBRMaterial` slots are plain
 * `texture_2d<f32>` and cannot read a layer.
 *
 * @example
 * ```ts
 * // Build a 3-layer array from images, then sample a chosen layer in a shader.
 * const atlas = await createTexture2DArrayFromUrls(engine, ["grass.png", "rock.png", "sand.png"]);
 *
 * const material = createShaderMaterial({
 *     attributes: ["position", "uv"],
 *     // Custom uniforms are exposed in WGSL via the `shaderUniforms` struct.
 *     uniforms: [{ name: "layer", type: "f32", defaultValue: 0 }],
 *     // A sampler named "atlas" emits `var atlas: texture_2d_array<f32>` plus `var atlasSampler: sampler`.
 *     samplers: [{ name: "atlas", viewDimension: "2d-array" }],
 *     vertexSource,
 *     fragmentSource: `
 *         @fragment fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
 *             return textureSample(atlas, atlasSampler, uv, i32(shaderUniforms.layer));
 *         }`,
 * });
 * setShaderTexture(material, "atlas", atlas);
 * setShaderUniform(material, "layer", 1); // sample the "rock" layer
 * ```
 */

import { TU } from "../engine/gpu-flags.js";
import { acquireTexture, getOrCreateSampler } from "../resource/gpu-pool.js";
import { generateMipmaps, recordMipmaps } from "./generate-mipmaps.js";
import { decodeKtx2Async, makeSampler, srgbFormat, uncompressedInfo } from "./ktx2-loader.js";
import type { Ktx2DecodedData, Ktx2DecodedMip } from "./ktx2-loader.js";
import { getCompressedFormat } from "./compressed-formats.js";
import type { CompressedFormatInfo } from "./compressed-formats.js";
import { mipLevelCount } from "./mip-count.js";
import type { Texture2D } from "./texture-2d.js";
import type { EngineContext } from "../engine/engine.js";

/** A 2D texture array handle. It is a `Texture2D` (so it drops straight into
 *  `setEffectTexture` / material sampler bindings) whose `view` is created with
 *  `dimension:"2d-array"`, plus a `layers` count. Bind it to a shader sampler
 *  declared `viewDimension:"2d-array"` and sample it in WGSL as
 *  `texture_2d_array<f32>`. */
export interface Texture2DArray extends Texture2D {
    layers: number;
}

/** Sampler and format options for `createTexture2DArray()`. */
export interface TextureArrayOptions {
    /** Generate a full mip chain for each layer on upload. Default true. */
    mipMaps?: boolean;
    /** Use sRGB format (rgba8unorm-srgb) so the hardware converts to linear on
     *  sample. Use for color/albedo layers in PBR workflows. Default false. */
    srgb?: boolean;
    /** Address mode U. Default 'repeat'. */
    addressModeU?: GPUAddressMode;
    /** Address mode V. Default 'repeat'. */
    addressModeV?: GPUAddressMode;
    /** Min filter. Default 'linear'. */
    minFilter?: GPUFilterMode;
    /** Mag filter. Default 'linear'. */
    magFilter?: GPUFilterMode;
}

/** Per-layer upload options for `uploadImageToArrayLayer()` / `loadImageToArrayLayer()`. */
export interface ArrayLayerUploadOptions {
    /** Flip Y during upload. Default true (matches Babylon.js convention). */
    invertY?: boolean;
    /** Treat the destination as premultiplied-alpha. Default false (straight RGBA). */
    premultiplyAlpha?: boolean;
}

/** Sampler, format and per-layer upload options for `createTexture2DArrayFromUrls()`. */
export interface TextureArrayFromUrlsOptions extends TextureArrayOptions, ArrayLayerUploadOptions {}

/**
 * Create an empty 2D texture array of `layers` same-size RGBA8 layers, ready to
 * be filled with `uploadImageToArrayLayer()` / `loadImageToArrayLayer()`.
 *
 * The texture is created with `TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT`
 * usage — `copyExternalImageToTexture` (used by the upload helpers) requires
 * both `COPY_DST` and `RENDER_ATTACHMENT` on the destination, and the render
 * attachment is also what the mipmap-blit pass writes into.
 *
 * @param engine - Engine context.
 * @param width - Layer width in texels (\>= 1).
 * @param height - Layer height in texels (\>= 1).
 * @param layers - Number of array layers (\>= 1).
 * @param options - Sampler / format overrides.
 */
export function createTexture2DArray(engine: EngineContext, width: number, height: number, layers: number, options: TextureArrayOptions = {}): Texture2DArray {
    if (width < 1 || height < 1 || layers < 1) {
        throw new Error(`createTexture2DArray: width/height/layers must be >= 1 (got ${width}x${height}x${layers})`);
    }

    const device = engine._device;
    const mipMaps = options.mipMaps ?? true;
    const format: GPUTextureFormat = options.srgb ? "rgba8unorm-srgb" : "rgba8unorm";

    const texture = device.createTexture({
        size: { width, height, depthOrArrayLayers: layers },
        dimension: "2d",
        format,
        mipLevelCount: mipMaps ? mipLevelCount(width, height) : 1,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.RENDER_ATTACHMENT,
    });

    const sampler = getOrCreateSampler(engine, {
        addressModeU: options.addressModeU ?? "repeat",
        addressModeV: options.addressModeV ?? "repeat",
        minFilter: options.minFilter ?? "linear",
        magFilter: options.magFilter ?? "linear",
        mipmapFilter: mipMaps ? "linear" : "nearest",
    });

    const tex: Texture2DArray = { texture, view: texture.createView({ dimension: "2d-array" }), sampler, width, height, layers };
    acquireTexture(tex);
    return tex;
}

/**
 * Fill one layer of a texture array from an already-decoded external image
 * source — an `ImageBitmap`, `ImageData`, canvas (`HTMLCanvasElement` /
 * `OffscreenCanvas`), `HTMLImageElement`, `HTMLVideoElement`, or `VideoFrame`.
 * All of these are accepted directly by WebGPU's `copyExternalImageToTexture`,
 * so this is a single GPU copy with no per-source-type branching. If the array
 * was created with mipmaps, the layer's mip chain is regenerated after upload.
 *
 * @param engine - Engine context.
 * @param tex - Target texture array (from `createTexture2DArray`).
 * @param layer - Destination layer index in `[0, tex.layers)`.
 * @param source - Any WebGPU external-image source sized `tex.width`×`tex.height`.
 * @param opts - Flip-Y / premultiply overrides.
 */
export function uploadImageToArrayLayer(engine: EngineContext, tex: Texture2DArray, layer: number, source: GPUCopyExternalImageSource, opts: ArrayLayerUploadOptions = {}): void {
    if (layer < 0 || layer >= tex.layers || (layer | 0) !== layer) {
        throw new Error(`uploadImageToArrayLayer: layer must be an integer in [0, ${tex.layers}) (got ${layer})`);
    }
    const invertY = opts.invertY ?? true;
    const premultipliedAlpha = opts.premultiplyAlpha ?? false;

    engine._device.queue.copyExternalImageToTexture({ source, flipY: invertY }, { texture: tex.texture, origin: [0, 0, layer], premultipliedAlpha }, [tex.width, tex.height, 1]);

    if (tex.texture.mipLevelCount > 1) {
        generateMipmaps(engine, tex.texture, layer);
    }
}

/**
 * Fetch an image from `url`, decode it to an `ImageBitmap`, and upload it into
 * `layer` of a texture array. This is the optional URL-loading counterpart to
 * `uploadImageToArrayLayer()`; keeping it a separate function means apps that
 * already hold a decoded source never pull in the fetch/decode path.
 *
 * @param engine - Engine context.
 * @param tex - Target texture array (from `createTexture2DArray`).
 * @param layer - Destination layer index in `[0, tex.layers)`.
 * @param url - Image URL to fetch and decode.
 * @param opts - Flip-Y / premultiply overrides.
 */
export async function loadImageToArrayLayer(engine: EngineContext, tex: Texture2DArray, layer: number, url: string, opts: ArrayLayerUploadOptions = {}): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`loadImageToArrayLayer: fetch failed for ${url} (${response.status})`);
    }
    const bitmap = await createImageBitmap(await response.blob(), {
        premultiplyAlpha: opts.premultiplyAlpha ? "premultiply" : "none",
        colorSpaceConversion: "none",
    });
    try {
        uploadImageToArrayLayer(engine, tex, layer, bitmap, opts);
    } finally {
        bitmap.close();
    }
}

/**
 * Create a 2D texture array and populate every layer from a list of image URLs
 * — one URL per layer, in order. All images must decode to the same dimensions
 * (the array's `width`/`height` are taken from the first). This is the
 * highest-level, most ergonomic entry point.
 *
 * @param engine - Engine context.
 * @param urls - One image URL per layer (`urls.length` \>= 1).
 * @param options - Sampler / format overrides, plus the per-layer `invertY` / `premultiplyAlpha` upload flags applied to every layer.
 * @returns A promise resolving to the populated `Texture2DArray`.
 */
export async function createTexture2DArrayFromUrls(
    engine: EngineContext,
    urls: readonly [string, ...string[]],
    options: TextureArrayFromUrlsOptions = {}
): Promise<Texture2DArray> {
    // allSettled (not all): a rejected fetch/decode must not leak the layers that
    // already decoded — Promise.all would reject on the first failure and orphan
    // every fulfilled ImageBitmap. Close the fulfilled ones, then rethrow.
    const results = await Promise.allSettled(
        urls.map(async (url) => {
            const r = await fetch(url);
            if (!r.ok) {
                throw new Error(`createTexture2DArrayFromUrls: fetch failed for ${url} (${r.status})`);
            }
            return createImageBitmap(await r.blob(), { premultiplyAlpha: options.premultiplyAlpha ? "premultiply" : "none", colorSpaceConversion: "none" });
        })
    );

    const firstRejection = results.find((res) => res.status === "rejected");
    if (firstRejection) {
        for (const res of results) {
            if (res.status === "fulfilled") {
                res.value.close();
            }
        }
        throw firstRejection.reason;
    }

    const bitmaps = results.filter((res): res is PromiseFulfilledResult<ImageBitmap> => res.status === "fulfilled").map((res) => res.value) as [ImageBitmap, ...ImageBitmap[]];

    const width = bitmaps[0].width;
    const height = bitmaps[0].height;
    for (const [i, bmp] of bitmaps.entries()) {
        if (bmp.width !== width || bmp.height !== height) {
            for (const b of bitmaps) {
                b.close();
            }
            throw new Error(`createTexture2DArrayFromUrls: all layers must share one size; layer 0 is ${width}x${height} but layer ${i} is ${bmp.width}x${bmp.height}`);
        }
    }

    const tex = createTexture2DArray(engine, width, height, bitmaps.length, options);
    for (const [i, bmp] of bitmaps.entries()) {
        uploadImageToArrayLayer(engine, tex, i, bmp, options);
        bmp.close();
    }
    return tex;
}

/**
 * Create a 2D texture array from a tightly-packed RGBA8 byte buffer covering **every**
 * layer — the array analog of `createTexture3DFromPixels`, and the raw-bytes
 * counterpart to {@link createTexture2DArrayFromUrls}. Use it when the layer contents
 * are CPU-generated (procedural tiles, decoded asset payloads, lookup tables) rather
 * than decoded images.
 *
 * If the array is created with mipmaps, a full mip chain is generated for each layer
 * after the upload.
 *
 * @param engine - Engine context.
 * @param data - `width * height * layers * 4` bytes, RGBA8, layer-major (all of layer 0's rows, then layer 1's, ...).
 * @param width - Layer width in texels (\>= 1).
 * @param height - Layer height in texels (\>= 1).
 * @param layers - Number of array layers (\>= 1).
 * @param options - Sampler / format overrides.
 */
export function createTexture2DArrayFromPixels(
    engine: EngineContext,
    data: Uint8Array,
    width: number,
    height: number,
    layers: number,
    options: TextureArrayOptions = {}
): Texture2DArray {
    const tex = createTexture2DArray(engine, width, height, layers, options);
    updateTexture2DArrayFromPixels(engine, tex, data);
    return tex;
}

/**
 * Re-upload one mip level of every layer of a texture array from a tightly-packed
 * RGBA8 byte buffer. This is the runtime counterpart to
 * {@link createTexture2DArrayFromPixels}.
 *
 * Uploading the base level (`mipLevel = 0`) of a mipmapped array regenerates the rest
 * of the chain; uploading an explicit higher level writes only that level, so an
 * application can author its own mip chain level by level.
 *
 * @param engine - Engine context.
 * @param tex - Target texture array (from `createTexture2DArray` / `createTexture2DArrayFromPixels`).
 * @param data - `mipWidth * mipHeight * tex.layers * 4` bytes, RGBA8, layer-major.
 * @param mipLevel - Destination mip level (default 0). Level dimensions are `max(1, size >> mipLevel)`.
 */
export function updateTexture2DArrayFromPixels(engine: EngineContext, tex: Texture2DArray, data: Uint8Array, mipLevel = 0): void {
    if (mipLevel < 0 || mipLevel >= tex.texture.mipLevelCount || (mipLevel | 0) !== mipLevel) {
        throw new Error(`updateTexture2DArrayFromPixels: mipLevel must be an integer in [0, ${tex.texture.mipLevelCount}) (got ${mipLevel})`);
    }
    const width = Math.max(1, tex.width >> mipLevel);
    const height = Math.max(1, tex.height >> mipLevel);
    const expected = width * height * tex.layers * 4;
    if (data.length < expected) {
        throw new Error(`updateTexture2DArrayFromPixels: data too short — need ${expected} bytes for ${width}x${height}x${tex.layers} RGBA at mip ${mipLevel}, got ${data.length}`);
    }

    engine._device.queue.writeTexture(
        { texture: tex.texture, mipLevel },
        data,
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height, depthOrArrayLayers: tex.layers }
    );

    // Only a base-level upload invalidates the rest of the chain; an explicit
    // higher-level write is the caller authoring that level themselves.
    if (mipLevel === 0 && tex.texture.mipLevelCount > 1) {
        const encoder = engine._device.createCommandEncoder();
        for (let layer = 0; layer < tex.layers; layer++) {
            recordMipmaps(engine, tex.texture, encoder, layer);
        }
        engine._device.queue.submit([encoder.finish()]);
    }
}

// ─── KTX2 (Basis Universal) array containers ─────────────────────────
//
// A single .ktx2 file can carry all N layers (`layerCount` > 1), which is the
// compressed, one-request counterpart to `createTexture2DArrayFromUrls()`. The
// decoder glue lives in ktx2-loader.ts; this module only reshapes its output and
// drives the GPU uploads — the same split Babylon.js uses between
// `KhronosTextureContainer2._decodeAsync` and `rawTexture2DArray.functions`.

/** Group the decoder's flat mipmap list into `[level][layer]`. The decoder emits `layerCount` consecutive
 *  entries per level, ordered by layer, so the grouping is a straight reshape — but `layerIndex` is verified
 *  rather than assumed so a decoder change cannot silently scramble the layers. */
function groupArrayMips(decoded: Ktx2DecodedData): { layers: number; levels: Ktx2DecodedMip[][] } {
    const mips = decoded.mipmaps;
    const layers = decoded.layerCount;
    if (layers === undefined) {
        throw new Error("KTX2: the decoder does not report layerCount; a decoder with 2D array support is required (see setKtx2DecoderUrl)");
    }
    if (layers < 1 || mips.length % layers !== 0) {
        throw new Error(`KTX2: decoder produced ${mips.length} mips, which is not a whole number of ${layers}-layer levels`);
    }

    const levels: Ktx2DecodedMip[][] = [];
    for (let i = 0; i < mips.length; i += layers) {
        const level = mips.slice(i, i + layers);
        for (let layer = 0; layer < layers; layer++) {
            const mip = level[layer]!;
            if (mip.layerIndex !== layer) {
                throw new Error(`KTX2: expected layer ${layer} at mip index ${i + layer} but the decoder reported layer ${mip.layerIndex}`);
            }
            if (mip.width !== level[0]!.width || mip.height !== level[0]!.height) {
                throw new Error(`KTX2: layers of one mip level must share a size (level ${levels.length}, layer ${layer})`);
            }
        }
        levels.push(level);
    }
    return { layers, levels };
}

function createKtx2ArrayTexture(engine: EngineContext, width: number, height: number, layers: number, levelCount: number, format: GPUTextureFormat, sRGB: boolean): Texture2DArray {
    const texture = engine._device.createTexture({
        size: { width, height, depthOrArrayLayers: layers },
        dimension: "2d",
        format: sRGB ? srgbFormat(format) : format,
        mipLevelCount: levelCount,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST,
    });
    // The mip chain comes from the container, so no RENDER_ATTACHMENT / blit pass is needed here (unlike
    // createTexture2DArray, which regenerates mips after an external-image copy).
    const tex: Texture2DArray = { texture, view: texture.createView({ dimension: "2d-array" }), sampler: makeSampler(engine, levelCount), width, height, layers, invertY: true };
    acquireTexture(tex);
    return tex;
}

function uploadCompressedKtx2Array(engine: EngineContext, decoded: Ktx2DecodedData, format: CompressedFormatInfo, sRGB: boolean): Texture2DArray {
    if (!engine._device.features.has(format.feature as GPUFeatureName)) {
        throw new Error(`KTX2: device does not support ${format.feature}`);
    }
    const { layers, levels } = groupArrayMips(decoded);
    const width = levels[0]![0]!.width;
    const height = levels[0]![0]!.height;
    const tex = createKtx2ArrayTexture(engine, width, height, layers, levels.length, format.gpuFormat, sRGB);

    for (let level = 0; level < levels.length; level++) {
        const blocksPerRow = Math.ceil(levels[level]![0]!.width / format.blockW);
        const rowBytes = blocksPerRow * format.blockBytes;
        // Copy extent must be the block-padded (physical) size; tail mips smaller than one block are copied
        // as a single full block (see ktx-loader.ts).
        const copyW = blocksPerRow * format.blockW;
        const copyH = Math.ceil(levels[level]![0]!.height / format.blockH) * format.blockH;
        for (let layer = 0; layer < layers; layer++) {
            const mip = levels[level]![layer]!;
            engine._device.queue.writeTexture(
                { texture: tex.texture, mipLevel: level, origin: { x: 0, y: 0, z: layer } },
                mip.data as Uint8Array<ArrayBuffer>,
                { bytesPerRow: rowBytes },
                { width: copyW, height: copyH, depthOrArrayLayers: 1 }
            );
        }
    }
    return tex;
}

function uploadUncompressedKtx2Array(engine: EngineContext, decoded: Ktx2DecodedData, info: { format: GPUTextureFormat; bytesPerPixel: number }, sRGB: boolean): Texture2DArray {
    const bytesPerPixel = info.bytesPerPixel;
    const { layers, levels } = groupArrayMips(decoded);
    const width = levels[0]![0]!.width;
    const height = levels[0]![0]!.height;
    const tex = createKtx2ArrayTexture(engine, width, height, layers, levels.length, info.format, sRGB);

    for (let level = 0; level < levels.length; level++) {
        const levelWidth = levels[level]![0]!.width;
        const levelHeight = levels[level]![0]!.height;
        for (let layer = 0; layer < layers; layer++) {
            const mip = levels[level]![layer]!;
            const expected = levelWidth * levelHeight * bytesPerPixel;
            if (mip.data.length !== expected) {
                throw new Error(`KTX2: uncompressed mip ${level} layer ${layer} has ${mip.data.length} bytes, expected ${expected}`);
            }
            engine._device.queue.writeTexture(
                { texture: tex.texture, mipLevel: level, origin: { x: 0, y: 0, z: layer } },
                mip.data as Uint8Array<ArrayBuffer>,
                { bytesPerRow: levelWidth * bytesPerPixel },
                { width: levelWidth, height: levelHeight, depthOrArrayLayers: 1 }
            );
        }
    }
    return tex;
}

/**
 * Decode an in-memory multi-layer KTX2 container and upload every layer of its mip chain to a
 * `Texture2DArray`. The buffer counterpart to {@link loadKtx2Texture2DArray} — use it when the bytes are
 * already in hand (an ArrayBuffer from a zip, an XHR, or a glTF binary chunk).
 *
 * @param engine - Engine context.
 * @param buffer - Raw `.ktx2` file bytes with `layerCount` \>= 1.
 * @param sRGB - Select the `*-srgb` GPU format. Default false.
 */
export async function uploadKtx2Texture2DArray(engine: EngineContext, buffer: ArrayBuffer, sRGB = false): Promise<Texture2DArray> {
    // Unlike Babylon.js core (which must transcode arrays to RGBA because its engine cannot upload compressed
    // array layers), WebGPU's writeTexture takes compressed layers directly via origin.z, so the array is kept
    // in a GPU-compressed format whenever the device supports one.
    const decoded = await decodeKtx2Async(engine, buffer);

    const compressed = getCompressedFormat(decoded.transcodedFormat);
    if (compressed) {
        return uploadCompressedKtx2Array(engine, decoded, compressed, sRGB);
    }

    const uncompressed = uncompressedInfo(decoded.transcodedFormat);
    if (uncompressed) {
        return uploadUncompressedKtx2Array(engine, decoded, uncompressed, sRGB);
    }

    throw new Error(`KTX2: unsupported transcoded format 0x${decoded.transcodedFormat.toString(16)}`);
}

/**
 * Fetch and decode a KTX2 file holding array layers (`layerCount` \>= 1) into a `Texture2DArray` —
 * the single-file, single-request counterpart to {@link createTexture2DArrayFromUrls}, which needs one image
 * per layer. A single-layer container is accepted and yields a one-layer array.
 *
 * The array is transcoded to the device's best GPU-compressed format (BC7/ETC2/ASTC) and stays compressed in
 * VRAM, and the container's authored mip chain is uploaded as-is rather than regenerated.
 *
 * Like every codec-decoded texture the data is uploaded unflipped with `invertY = true` (GUIDANCE §8 path 2),
 * unlike `createTexture2DArrayFromUrls` which flips on upload. No built-in material samples an array, so
 * honour that flag in your own WGSL (`v = 1 - v`).
 *
 * Requires a KTX2 decoder with 2D array support (configure self-hosting via `setKtx2DecoderUrl`).
 *
 * @param engine - Engine context.
 * @param url - URL of a `.ktx2` file whose layers become the array's layers, in order.
 * @param sRGB - Select the `*-srgb` GPU format. Default false, matching `loadKtx2Texture2D`.
 * @returns A promise resolving to the populated `Texture2DArray`.
 */
export async function loadKtx2Texture2DArray(engine: EngineContext, url: string, sRGB = false): Promise<Texture2DArray> {
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`KTX2 fetch failed: ${resp.status} for ${url}`);
    }
    return uploadKtx2Texture2DArray(engine, await resp.arrayBuffer(), sRGB);
}
