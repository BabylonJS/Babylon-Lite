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
 * {@link loadKtx2Texture2DArrayFromUrls} combines separate single-layer KTX2
 * files into one array while preserving their authored mip chains.
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
import { acquireTexture } from "../resource/texture-acquire.js";
import { getOrCreateSampler } from "../resource/texture-sampler-pool.js";
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
    if (!Number.isInteger(layers) || layers < 1 || mips.length < 1 || mips.length % layers !== 0) {
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

interface Ktx2ArrayUploadPlanBase {
    layers: number;
    levels: Ktx2DecodedMip[][];
    width: number;
    height: number;
    gpuFormat: GPUTextureFormat;
}

interface CompressedKtx2ArrayUploadPlan extends Ktx2ArrayUploadPlanBase {
    kind: "compressed";
    info: CompressedFormatInfo;
}

interface UncompressedKtx2ArrayUploadPlan extends Ktx2ArrayUploadPlanBase {
    kind: "uncompressed";
    bytesPerPixel: number;
}

type Ktx2ArrayUploadPlan = CompressedKtx2ArrayUploadPlan | UncompressedKtx2ArrayUploadPlan;

function validateKtx2ArrayDimensions(decoded: Ktx2DecodedData, levels: readonly Ktx2DecodedMip[][]): { width: number; height: number } {
    if (!Number.isInteger(decoded.width) || !Number.isInteger(decoded.height) || decoded.width < 1 || decoded.height < 1) {
        throw new Error(`KTX2: decoder reported invalid dimensions ${decoded.width}x${decoded.height}`);
    }
    const width = levels[0]![0]!.width;
    const height = levels[0]![0]!.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new Error(`KTX2: decoder produced invalid base mip dimensions ${width}x${height}`);
    }
    for (let level = 0; level < levels.length; level++) {
        const expectedWidth = Math.max(width >> level, 1);
        const expectedHeight = Math.max(height >> level, 1);
        const mip = levels[level]![0]!;
        if (mip.width !== expectedWidth || mip.height !== expectedHeight) {
            throw new Error(`KTX2: mip ${level} has size ${mip.width}x${mip.height}, expected ${expectedWidth}x${expectedHeight}`);
        }
    }
    return { width, height };
}

function preflightKtx2ArrayUpload(engine: EngineContext, decoded: Ktx2DecodedData, sRGB: boolean): Ktx2ArrayUploadPlan {
    const { layers, levels } = groupArrayMips(decoded);
    const { width, height } = validateKtx2ArrayDimensions(decoded, levels);
    const limits = engine._device.limits;
    if (width > limits.maxTextureDimension2D || height > limits.maxTextureDimension2D) {
        throw new Error(`KTX2: texture dimensions ${width}x${height} exceed maxTextureDimension2D ${limits.maxTextureDimension2D}`);
    }
    if (layers > limits.maxTextureArrayLayers) {
        throw new Error(`KTX2: array has ${layers} layers, exceeding maxTextureArrayLayers ${limits.maxTextureArrayLayers}`);
    }
    const maxMipLevels = Math.floor(Math.log2(Math.max(width, height))) + 1;
    if (levels.length > maxMipLevels) {
        throw new Error(`KTX2: texture ${width}x${height} has ${levels.length} mip levels, exceeding the maximum ${maxMipLevels}`);
    }

    const compressed = getCompressedFormat(decoded.transcodedFormat);
    if (compressed) {
        if (!engine._device.features.has(compressed.feature as GPUFeatureName)) {
            throw new Error(`KTX2: device does not support ${compressed.feature}`);
        }
        const blockAligned = width % compressed.blockW === 0 && height % compressed.blockH === 0;
        if (!blockAligned && !engine._device.features.has("texture-compression-unaligned" as GPUFeatureName)) {
            throw new Error(
                `KTX2: compressed dimensions ${width}x${height} are not aligned to ${compressed.blockW}x${compressed.blockH} blocks; texture-compression-unaligned is required`
            );
        }
        for (let level = 0; level < levels.length; level++) {
            const levelWidth = levels[level]![0]!.width;
            const levelHeight = levels[level]![0]!.height;
            const expected = Math.ceil(levelWidth / compressed.blockW) * Math.ceil(levelHeight / compressed.blockH) * compressed.blockBytes;
            for (let layer = 0; layer < layers; layer++) {
                const actual = levels[level]![layer]!.data.length;
                if (actual !== expected) {
                    throw new Error(`KTX2: compressed mip ${level} layer ${layer} has ${actual} bytes, expected ${expected}`);
                }
            }
        }
        return {
            kind: "compressed",
            layers,
            levels,
            width,
            height,
            gpuFormat: sRGB ? srgbFormat(compressed.gpuFormat) : compressed.gpuFormat,
            info: compressed,
        };
    }

    const uncompressed = uncompressedInfo(decoded.transcodedFormat);
    if (uncompressed) {
        for (let level = 0; level < levels.length; level++) {
            const levelWidth = levels[level]![0]!.width;
            const levelHeight = levels[level]![0]!.height;
            const expected = levelWidth * levelHeight * uncompressed.bytesPerPixel;
            for (let layer = 0; layer < layers; layer++) {
                const actual = levels[level]![layer]!.data.length;
                if (actual !== expected) {
                    throw new Error(`KTX2: uncompressed mip ${level} layer ${layer} has ${actual} bytes, expected ${expected}`);
                }
            }
        }
        return {
            kind: "uncompressed",
            layers,
            levels,
            width,
            height,
            gpuFormat: sRGB ? srgbFormat(uncompressed.format) : uncompressed.format,
            bytesPerPixel: uncompressed.bytesPerPixel,
        };
    }

    throw new Error(`KTX2: unsupported transcoded format 0x${decoded.transcodedFormat.toString(16)}`);
}

function createKtx2ArrayTexture(engine: EngineContext, plan: Ktx2ArrayUploadPlan): Texture2DArray {
    const texture = engine._device.createTexture({
        size: { width: plan.width, height: plan.height, depthOrArrayLayers: plan.layers },
        dimension: "2d",
        format: plan.gpuFormat,
        mipLevelCount: plan.levels.length,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST,
    });
    try {
        // The mip chain comes from the container, so no RENDER_ATTACHMENT / blit pass is needed here.
        return {
            texture,
            view: texture.createView({ dimension: "2d-array" }),
            sampler: makeSampler(engine, plan.levels.length),
            width: plan.width,
            height: plan.height,
            layers: plan.layers,
            invertY: true,
        };
    } catch (error) {
        texture.destroy();
        throw error;
    }
}

function uploadPreparedKtx2Array(engine: EngineContext, plan: Ktx2ArrayUploadPlan): Texture2DArray {
    const tex = createKtx2ArrayTexture(engine, plan);
    try {
        for (let level = 0; level < plan.levels.length; level++) {
            const levelWidth = plan.levels[level]![0]!.width;
            const levelHeight = plan.levels[level]![0]!.height;
            let rowBytes: number;
            let copyWidth: number;
            let copyHeight: number;
            if (plan.kind === "compressed") {
                rowBytes = Math.ceil(levelWidth / plan.info.blockW) * plan.info.blockBytes;
                copyWidth = Math.ceil(levelWidth / plan.info.blockW) * plan.info.blockW;
                copyHeight = Math.ceil(levelHeight / plan.info.blockH) * plan.info.blockH;
            } else {
                rowBytes = levelWidth * plan.bytesPerPixel;
                copyWidth = levelWidth;
                copyHeight = levelHeight;
            }
            for (let layer = 0; layer < plan.layers; layer++) {
                const mip = plan.levels[level]![layer]!;
                engine._device.queue.writeTexture(
                    { texture: tex.texture, mipLevel: level, origin: { x: 0, y: 0, z: layer } },
                    mip.data as Uint8Array<ArrayBuffer>,
                    { bytesPerRow: rowBytes },
                    { width: copyWidth, height: copyHeight, depthOrArrayLayers: 1 }
                );
            }
        }
        acquireTexture(tex);
        return tex;
    } catch (error) {
        tex.texture.destroy();
        throw error;
    }
}

function uploadDecodedKtx2Array(engine: EngineContext, decoded: Ktx2DecodedData, sRGB: boolean): Texture2DArray {
    return uploadPreparedKtx2Array(engine, preflightKtx2ArrayUpload(engine, decoded, sRGB));
}

function exactArrayBuffer(buffer: ArrayBuffer | ArrayBufferView): ArrayBuffer {
    if (ArrayBuffer.isView(buffer)) {
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice().buffer;
    }
    return buffer;
}

/** Merge decoded single-layer KTX2 files into the level-major ordering expected by the array uploader. */
function mergeSeparateKtx2Layers(decodedLayers: readonly Ktx2DecodedData[]): Ktx2DecodedData {
    if (decodedLayers.length < 1) {
        throw new Error("KTX2: at least one separate layer buffer is required");
    }
    const first = decodedLayers[0]!;
    const levelCount = first.mipmaps.length;
    const mipmaps: Ktx2DecodedMip[] = [];

    for (let layer = 0; layer < decodedLayers.length; layer++) {
        const decoded = decodedLayers[layer]!;
        if (decoded.layerCount !== undefined && decoded.layerCount !== 1) {
            throw new Error(`KTX2: separate layer ${layer} reports layerCount ${decoded.layerCount}; expected one 2D layer`);
        }
        if (decoded.transcodedFormat !== first.transcodedFormat) {
            throw new Error(`KTX2: separate layer ${layer} has a different transcoded format`);
        }
        if (decoded.width !== first.width || decoded.height !== first.height) {
            throw new Error(`KTX2: separate layer ${layer} has size ${decoded.width}x${decoded.height}, expected ${first.width}x${first.height}`);
        }
        if (decoded.mipmaps.length !== levelCount) {
            throw new Error(`KTX2: separate layer ${layer} has ${decoded.mipmaps.length} mip levels, expected ${levelCount}`);
        }
    }

    for (let level = 0; level < levelCount; level++) {
        const expected = first.mipmaps[level]!;
        for (let layer = 0; layer < decodedLayers.length; layer++) {
            const mip = decodedLayers[layer]!.mipmaps[level]!;
            if (mip.width !== expected.width || mip.height !== expected.height) {
                throw new Error(`KTX2: separate layer ${layer} mip ${level} has size ${mip.width}x${mip.height}, expected ${expected.width}x${expected.height}`);
            }
            mipmaps.push({ ...mip, layerIndex: layer });
        }
    }

    return { ...first, layerCount: decodedLayers.length, mipmaps };
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

    return uploadDecodedKtx2Array(engine, decoded, sRGB);
}

/**
 * Decode separate single-layer KTX2 files and upload them as one `Texture2DArray`.
 * Source `buffers[i]` becomes array layer `i`. Every source must transcode to the
 * same format and expose the same dimensions and authored mip chain.
 *
 * @param engine - Engine context.
 * @param buffers - Ordered single-layer KTX2 buffers.
 * @param sRGB - Select the `*-srgb` GPU format. Default false.
 */
export async function uploadKtx2Texture2DArrayFromBuffers(engine: EngineContext, buffers: readonly (ArrayBuffer | ArrayBufferView)[], sRGB = false): Promise<Texture2DArray> {
    if (buffers.length < 1) {
        throw new Error("KTX2: at least one separate layer buffer is required");
    }
    const normalizedBuffers = buffers.map(exactArrayBuffer);
    const decodedLayers = await Promise.all(normalizedBuffers.map((buffer) => decodeKtx2Async(engine, buffer)));
    return uploadDecodedKtx2Array(engine, mergeSeparateKtx2Layers(decodedLayers), sRGB);
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

/**
 * Fetch separate single-layer KTX2 files and combine them into one `Texture2DArray`.
 * URL order defines array-layer order.
 *
 * @param engine - Engine context.
 * @param urls - Ordered single-layer KTX2 URLs.
 * @param sRGB - Select the `*-srgb` GPU format. Default false.
 */
export async function loadKtx2Texture2DArrayFromUrls(engine: EngineContext, urls: readonly string[], sRGB = false): Promise<Texture2DArray> {
    if (urls.length < 1) {
        throw new Error("KTX2: at least one separate layer URL is required");
    }
    const buffers = await Promise.all(
        urls.map(async (url) => {
            const resp = await fetch(url);
            if (!resp.ok) {
                throw new Error(`KTX2 fetch failed: ${resp.status} for ${url}`);
            }
            return resp.arrayBuffer();
        })
    );
    return uploadKtx2Texture2DArrayFromBuffers(engine, buffers, sRGB);
}
