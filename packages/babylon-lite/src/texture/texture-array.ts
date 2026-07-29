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
