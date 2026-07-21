/**
 * Dynamic (canvas-/bitmap-backed) 2D textures — the WebGPU-native analog of
 * Babylon.js `DynamicTexture`.
 *
 * A dynamic texture is an ordinary {@link Texture2D} allocated **blank** with
 * write-capable usage flags, whose pixels are pushed on demand from any WebGPU
 * external-image source — a canvas (`HTMLCanvasElement` / `OffscreenCanvas`),
 * `ImageBitmap`, `ImageData`, `HTMLImageElement`, `HTMLVideoElement`, or
 * `VideoFrame`. This is the 2D twin of {@link uploadImageToArrayLayer}: a single
 * GPU copy (`copyExternalImageToTexture`) with no CPU readback, replacing the
 * "draw to an offscreen canvas, `getImageData`, upload raw bytes" dance.
 *
 * The familiar Babylon.js workflow ports almost verbatim — the only difference
 * is that the caller owns the canvas + 2D context rather than the texture object:
 *
 * @example
 * ```ts
 * const canvas = document.createElement("canvas");
 * canvas.width = 256; canvas.height = 64;
 * const ctx = canvas.getContext("2d")!;
 * const label = createDynamicTexture(engine, 256, 64, { srgb: true });
 * material.diffuseTexture = label; // it's a Texture2D
 *
 * // draw + push whenever the label changes
 * ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 256, 64);
 * ctx.fillStyle = "#fff"; ctx.font = "40px sans-serif";
 * ctx.fillText("600 mm", 10, 44);
 * updateDynamicTexture(engine, label, canvas);
 * ```
 *
 * The whole feature is a set of free functions with zero module-level side
 * effects, so an app that never creates a dynamic texture strips it entirely.
 */

import { TU } from "../engine/gpu-flags.js";
import { acquireTexture, getOrCreateSampler } from "../resource/gpu-pool.js";
import { generateMipmaps } from "./generate-mipmaps.js";
import { mipLevelCount } from "./mip-count.js";
import type { Texture2D, Texture2DRecoverySource } from "./texture-2d.js";
import type { EngineContext } from "../engine/engine.js";

declare const dynamicTexture2DBrand: unique symbol;

/**
 * A {@link Texture2D} created by {@link createDynamicTexture}: allocated blank
 * with `COPY_DST | RENDER_ATTACHMENT` usage so it can be written repeatedly from
 * an external-image source. It is a `Texture2D` (drops straight into any material
 * texture slot), plus an opaque nominal brand that constrains
 * {@link updateDynamicTexture} to accept only textures produced here — a plain
 * `Texture2D` from `loadTexture2D` / `createTexture2DFromPixels` is rejected at
 * compile time.
 */
export interface DynamicTexture2D extends Texture2D {
    /** Opaque nominal brand. */
    readonly [dynamicTexture2DBrand]: true;
}

/** Sampler, format, and mipmap overrides for {@link createDynamicTexture}. */
export interface DynamicTexture2DOptions {
    /** Address mode U. Default 'clamp-to-edge'. */
    addressModeU?: GPUAddressMode;
    /** Address mode V. Default 'clamp-to-edge'. */
    addressModeV?: GPUAddressMode;
    /** Min filter. Default 'linear'. */
    minFilter?: GPUFilterMode;
    /** Mag filter. Default 'linear'. */
    magFilter?: GPUFilterMode;
    /** Generate a mip chain (rebuilt after each {@link updateDynamicTexture}).
     *  Default false. */
    mipMaps?: boolean;
    /** Use sRGB format (rgba8unorm-srgb) so the hardware converts to linear on
     *  sample. Use for colour content (text labels, procedural patterns) fed to a
     *  PBR/standard material; leave false for data. Default false. */
    srgb?: boolean;
}

/** Flip-Y / premultiply overrides for {@link updateDynamicTexture}. */
export interface DynamicTextureUpdateOptions {
    /** Flip Y during upload. Default true (matches the Babylon.js Y-up convention,
     *  so a canvas drawn top-down samples upright with no per-material flag). */
    invertY?: boolean;
    /** Treat the destination as premultiplied-alpha. Default false (straight RGBA). */
    premultiplyAlpha?: boolean;
}

/**
 * Create a blank, immediately-sampleable `DynamicTexture2D` of `width × height`
 * whose pixels are pushed on demand with {@link updateDynamicTexture}. Reads as
 * transparent black until the first update.
 *
 * The texture is created with `TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT`
 * usage — `copyExternalImageToTexture` (used by the update helper) requires both
 * `COPY_DST` and `RENDER_ATTACHMENT` on the destination, and the render
 * attachment is also what the mipmap-blit pass writes into.
 *
 * @param engine - Engine context.
 * @param width - Texture width in texels (\>= 1).
 * @param height - Texture height in texels (\>= 1).
 * @param options - Sampler / format / mipmap overrides.
 */
export function createDynamicTexture(engine: EngineContext, width: number, height: number, options: DynamicTexture2DOptions = {}): DynamicTexture2D {
    if (width < 1 || height < 1) {
        throw new Error(`createDynamicTexture: width/height must be >= 1 (got ${width}x${height})`);
    }

    const device = engine._device;
    const mipMaps = options.mipMaps ?? false;
    const format: GPUTextureFormat = options.srgb ? "rgba8unorm-srgb" : "rgba8unorm";
    const levels = mipMaps ? mipLevelCount(width, height) : 1;

    const texture = device.createTexture({
        size: { width, height },
        format,
        mipLevelCount: levels,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.RENDER_ATTACHMENT,
    });

    const samplerDesc: GPUSamplerDescriptor = {
        addressModeU: options.addressModeU ?? "clamp-to-edge",
        addressModeV: options.addressModeV ?? "clamp-to-edge",
        minFilter: options.minFilter ?? "linear",
        magFilter: options.magFilter ?? "linear",
        mipmapFilter: mipMaps ? "linear" : "nearest",
    };
    const sampler = getOrCreateSampler(engine, samplerDesc);

    const tex: Texture2D = { texture, view: texture.createView(), sampler, width, height };
    acquireTexture(tex);
    // Opt-in device-lost recovery: retain only the *data* needed to re-allocate the
    // blank texture identically — no logic here. Like the url/solid/bitmap recovery
    // kinds, the actual rebuild lives elsewhere (the dynamic-texture-recovery
    // module, dynamically imported by device-lost-recovery only when needed), so
    // the create/update API never bundles recovery code. `engine._dlr` is a runtime
    // flag, so this is a runtime gate (a no-op when recovery is disabled), not
    // compile-time dead-code elimination. The latest source is stamped by
    // updateDynamicTexture.
    if (engine._dlr) {
        const rec: Texture2DRecoverySource = {
            kind: "dynamic",
            width,
            height,
            format,
            levels,
            samplerDesc,
            source: null,
            flipY: true,
            premultipliedAlpha: false,
        };
        tex._recoverySource = rec;
    }
    return tex as DynamicTexture2D;
}

/**
 * Push pixels into a {@link createDynamicTexture} texture from an external-image
 * source — a canvas (`HTMLCanvasElement` / `OffscreenCanvas`), `ImageBitmap`,
 * `ImageData`, `HTMLImageElement`, `HTMLVideoElement`, or `VideoFrame`. All of
 * these are accepted directly by WebGPU's `copyExternalImageToTexture`, so this
 * is a single GPU copy with no CPU readback. If the texture was created with
 * mipmaps, its mip chain is regenerated after upload.
 *
 * @param engine - Engine context.
 * @param tex - Target texture (from {@link createDynamicTexture}).
 * @param source - A WebGPU external-image source sized `tex.width`×`tex.height`.
 * @param opts - Flip-Y / premultiply overrides.
 */
export function updateDynamicTexture(engine: EngineContext, tex: DynamicTexture2D, source: GPUCopyExternalImageSource, opts: DynamicTextureUpdateOptions = {}): void {
    const invertY = opts.invertY ?? true;
    const premultipliedAlpha = opts.premultiplyAlpha ?? false;

    engine._device.queue.copyExternalImageToTexture({ source, flipY: invertY }, { texture: tex.texture, premultipliedAlpha }, [tex.width, tex.height]);

    // Keep the retained recovery source current so a device-lost rebuild
    // re-blits the most recent pixels (no-op unless recovery is enabled).
    const rec = tex._recoverySource;
    if (rec && rec.kind === "dynamic") {
        rec.source = source;
        rec.flipY = invertY;
        rec.premultipliedAlpha = premultipliedAlpha;
    }

    if (tex.texture.mipLevelCount > 1) {
        generateMipmaps(engine, tex.texture);
    }
}
