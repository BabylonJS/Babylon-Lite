/**
 * Fresh 2D textures from already-decoded WebGPU external-image sources.
 *
 * Each call creates an independently-owned GPU texture. The source remains
 * caller-owned; only a temporary bitmap created for downscaling is closed here.
 */

import { TU } from "../engine/gpu-flags.js";
import { acquireTexture, getOrCreateSampler } from "../resource/gpu-pool.js";
import { mipLevelCount } from "./mip-count.js";
import type { EngineContext } from "../engine/engine.js";
import type { Texture2D, Texture2DOptions } from "./texture-2d.js";

/** Sampler, format, upload, and downscaling options for {@link createTexture2DFromExternalImage}. */
export interface ExternalImageTexture2DOptions extends Texture2DOptions {
    /** Downscale when the larger source dimension exceeds this positive integer.
     *  Aspect ratio is preserved and smaller sources are never enlarged. */
    maxDimension?: number;
}

type ExternalImageDimensions = {
    displayWidth?: number;
    displayHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    width?: number;
    height?: number;
};

function getExternalImageSize(source: GPUCopyExternalImageSource): readonly [number, number] {
    const dimensions = source as ExternalImageDimensions;
    const pairs: readonly (readonly [number | undefined, number | undefined])[] = [
        [dimensions.displayWidth, dimensions.displayHeight],
        [dimensions.videoWidth, dimensions.videoHeight],
        [dimensions.naturalWidth, dimensions.naturalHeight],
        [dimensions.width, dimensions.height],
    ];
    for (const [width, height] of pairs) {
        if (width !== undefined && height !== undefined && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) {
            return [width, height];
        }
    }
    throw new TypeError("createTexture2DFromExternalImage: source has no supported positive intrinsic dimensions");
}

function getTargetSize(width: number, height: number, maxDimension: number | undefined): readonly [number, number] {
    if (maxDimension === undefined) {
        return [width, height];
    }
    if (!Number.isInteger(maxDimension) || maxDimension < 1) {
        throw new TypeError(`createTexture2DFromExternalImage: maxDimension must be a positive integer (got ${maxDimension})`);
    }
    if (Math.max(width, height) <= maxDimension) {
        return [width, height];
    }
    const scale = maxDimension / Math.max(width, height);
    return width >= height ? [maxDimension, Math.max(1, Math.round(height * scale))] : [Math.max(1, Math.round(width * scale)), maxDimension];
}

/**
 * Create a fresh, normal {@link Texture2D} from an already-decoded external
 * image. Supported sources are the platform types accepted by WebGPU's
 * `copyExternalImageToTexture`, including `ImageBitmap`, `ImageData`, DOM or
 * offscreen canvases, image/video elements, and `VideoFrame`.
 *
 * Every invocation allocates a distinct GPU texture; no source or URL cache is
 * used. The caller keeps ownership of `source`, and this function never closes
 * it. The returned texture owns one resource-pool reference and must be released
 * with `releaseTexture` after it is detached from all materials.
 *
 * @param engine - Engine context.
 * @param source - An already-decoded WebGPU external-image source.
 * @param options - Sampler, format, upload, and optional downscaling overrides.
 * @returns A newly allocated texture. Resize/decode and upload failures reject.
 *
 * @example
 * ```ts
 * const bitmap = await createImageBitmap(blob);
 * const texture = await createTexture2DFromExternalImage(engine, bitmap, {
 *     maxDimension: 2048,
 *     invertY: true,
 *     srgb: true,
 * });
 * bitmap.close();
 * material.diffuseTexture = texture;
 * // After detaching it from every material:
 * releaseTexture(texture);
 * ```
 */
export async function createTexture2DFromExternalImage(engine: EngineContext, source: GPUCopyExternalImageSource, options: ExternalImageTexture2DOptions = {}): Promise<Texture2D> {
    const [sourceWidth, sourceHeight] = getExternalImageSize(source);
    const [width, height] = getTargetSize(sourceWidth, sourceHeight, options.maxDimension);
    const mipMaps = options.mipMaps ?? true;
    const premultiplyAlpha = options.premultiplyAlpha ?? false;
    let uploadSource = source;
    let resized: ImageBitmap | null = null;
    let recoveryBitmap: ImageBitmap | null = null;

    if (width !== sourceWidth || height !== sourceHeight) {
        resized = await createImageBitmap(source, {
            resizeWidth: width,
            resizeHeight: height,
            resizeQuality: "high",
            premultiplyAlpha: premultiplyAlpha ? "premultiply" : "none",
            colorSpaceConversion: "none",
        });
        uploadSource = resized;
    }

    const device = engine._device;
    const format: GPUTextureFormat = options.srgb ? "rgba8unorm-srgb" : "rgba8unorm";
    const levels = mipMaps ? mipLevelCount(width, height) : 1;
    const generate = levels > 1 ? (await import("./generate-mipmaps.js")).generateMipmaps : null;
    const samplerDesc: GPUSamplerDescriptor = {
        addressModeU: options.addressModeU ?? "repeat",
        addressModeV: options.addressModeV ?? "repeat",
        minFilter: options.minFilter ?? "linear",
        magFilter: options.magFilter ?? "linear",
        mipmapFilter: mipMaps ? "linear" : "nearest",
    };
    samplerDesc.maxAnisotropy = samplerDesc.minFilter === "linear" && samplerDesc.magFilter === "linear" && samplerDesc.mipmapFilter === "linear" ? 4 : 1;

    if (engine._dlr) {
        if (resized) {
            recoveryBitmap = resized;
            resized = null;
        } else {
            recoveryBitmap = await createImageBitmap(source, {
                premultiplyAlpha: premultiplyAlpha ? "premultiply" : "none",
                colorSpaceConversion: "none",
            });
            uploadSource = recoveryBitmap;
        }
    }

    let texture: GPUTexture | null = null;
    try {
        device.pushErrorScope("validation");
        device.pushErrorScope("out-of-memory");
        let operationError: unknown;
        let sampler: GPUSampler | null = null;
        try {
            texture = device.createTexture({
                size: { width, height },
                format,
                mipLevelCount: levels,
                usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.RENDER_ATTACHMENT,
            });
            device.queue.copyExternalImageToTexture({ source: uploadSource, flipY: options.invertY ?? true }, { texture, premultipliedAlpha: premultiplyAlpha }, { width, height });

            if (generate) {
                generate(engine, texture);
            }

            sampler = getOrCreateSampler(engine, samplerDesc);
        } catch (error) {
            operationError = error;
        }

        const [outOfMemoryError, validationError] = await Promise.all([device.popErrorScope(), device.popErrorScope()]);
        if (operationError) {
            throw operationError;
        }
        const gpuError = validationError ?? outOfMemoryError;
        if (gpuError) {
            throw new Error(`createTexture2DFromExternalImage: GPU upload failed: ${gpuError.message}`, { cause: gpuError });
        }
        if (!texture || !sampler) {
            throw new Error("createTexture2DFromExternalImage: texture creation did not produce GPU resources");
        }

        const result: Texture2D = { texture, view: texture.createView(), sampler, width, height };
        if (recoveryBitmap) {
            engine._dlr?.t(result, {
                kind: "external",
                bitmap: recoveryBitmap,
                width,
                height,
                format,
                levels,
                samplerDesc,
                flipY: options.invertY ?? true,
                premultipliedAlpha: premultiplyAlpha,
            });
            if (result._recoverySource?.kind !== "external") {
                recoveryBitmap.close();
            } else {
                recoveryBitmap = null;
            }
        }
        acquireTexture(result);
        return result;
    } catch (error) {
        texture?.destroy();
        recoveryBitmap?.close();
        throw error;
    } finally {
        resized?.close();
    }
}
