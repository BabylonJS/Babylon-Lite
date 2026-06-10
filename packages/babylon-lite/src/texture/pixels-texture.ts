/**
 * Create a 2D texture from raw pixel bytes (CPU-generated data).
 *
 * This is the generic analog to Babylon.js `RawTexture`: it uploads an
 * application-provided byte buffer into a GPU texture rather than decoding an
 * image from a URL. Use it for procedurally generated images, decoded asset
 * formats, or palette / lookup tables.
 *
 * The default sampler is nearest-neighbor with clamp-to-edge addressing and no
 * mipmaps — the common case for pixel-art / data textures. Override via options.
 */

import { TU } from "../engine/gpu-flags.js";
import type { Texture2D } from "./texture-2d.js";
import type { EngineContext } from "../engine/engine.js";
import { acquireTexture, getOrCreateSampler } from "../resource/gpu-pool.js";

/** Sampler and format overrides for `createTexture2DFromPixels()`. */
export interface PixelsTexture2DOptions {
    /** Address mode U. Default 'clamp-to-edge'. */
    addressModeU?: GPUAddressMode;
    /** Address mode V. Default 'clamp-to-edge'. */
    addressModeV?: GPUAddressMode;
    /** Min filter. Default 'nearest'. */
    minFilter?: GPUFilterMode;
    /** Mag filter. Default 'nearest'. */
    magFilter?: GPUFilterMode;
    /** Use sRGB format (rgba8unorm-srgb) so the hardware converts to linear on
     *  sample. Use for color data; leave false for lookup tables. Default false. */
    srgb?: boolean;
}

/**
 * Create a `Texture2D` from a tightly-packed RGBA8 byte buffer.
 *
 * @param engine - Engine context.
 * @param data - `width * height * 4` bytes, row-major, top-to-bottom, straight alpha.
 * @param width - Texture width in pixels (\>= 1).
 * @param height - Texture height in pixels (\>= 1).
 * @param options - Sampler / format overrides.
 */
export function createTexture2DFromPixels(engine: EngineContext, data: Uint8Array, width: number, height: number, options: PixelsTexture2DOptions = {}): Texture2D {
    if (width < 1 || height < 1) {
        throw new Error(`createTexture2DFromPixels: width/height must be >= 1 (got ${width}x${height})`);
    }
    const expected = width * height * 4;
    if (data.length < expected) {
        throw new Error(`createTexture2DFromPixels: data too short — need ${expected} bytes for ${width}x${height} RGBA, got ${data.length}`);
    }

    const device = engine._device;
    const format: GPUTextureFormat = options.srgb ? "rgba8unorm-srgb" : "rgba8unorm";

    const texture = device.createTexture({
        size: { width, height },
        format,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST,
    });

    device.queue.writeTexture({ texture }, data as Uint8Array<ArrayBuffer>, { bytesPerRow: width * 4, rowsPerImage: height }, { width, height });

    const sampler = getOrCreateSampler(engine, {
        addressModeU: options.addressModeU ?? "clamp-to-edge",
        addressModeV: options.addressModeV ?? "clamp-to-edge",
        minFilter: options.minFilter ?? "nearest",
        magFilter: options.magFilter ?? "nearest",
    });

    const tex: Texture2D = { texture, view: texture.createView(), sampler, width, height };
    acquireTexture(tex);
    return tex;
}

/** Sampler / format overrides for `createRenderTexture2D()`. */
export interface RenderTexture2DOptions {
    /** Address mode U. Default 'clamp-to-edge'. */
    addressModeU?: GPUAddressMode;
    /** Address mode V. Default 'clamp-to-edge'. */
    addressModeV?: GPUAddressMode;
    /** Min filter. Default 'linear'. */
    minFilter?: GPUFilterMode;
    /** Mag filter. Default 'linear'. */
    magFilter?: GPUFilterMode;
    /**
     * Color format. Default `engine.format` so it can be sampled and presented.
     *
     * ⚠️ Only the default `engine.format` is compatible with a `SpriteRenderer`
     * target (`setSpriteRendererTarget`): sprite pipelines are created with
     * `engine.format`, and a render pass whose color attachment format differs from
     * the bound pipeline fails WebGPU validation at pass begin. Override this **only**
     * for offscreen targets you render into by some OTHER means (a custom pass /
     * `EffectRenderer`), never as a sprite-render target.
     */
    format?: GPUTextureFormat;
}

/**
 * Create an empty `Texture2D` usable as **both a render target and a sampled texture**
 * (`RENDER_ATTACHMENT | TEXTURE_BINDING`). This is the building block for offscreen
 * render-to-texture: render a pass into `tex.view`, then sample `tex` in a later pass
 * (e.g. a fullscreen post-process). Defaults to the engine's swapchain format + a
 * linear sampler so the result can be presented directly.
 *
 * To use the result as a `SpriteRenderer` target (via `setSpriteRendererTarget`), leave
 * `format` at its default `engine.format` — sprite pipelines bake in that format, so a
 * differently-formatted target trips WebGPU validation at render-pass begin. A custom
 * `format` is for offscreen targets driven by some other pass, not the sprite renderer.
 */
export function createRenderTexture2D(engine: EngineContext, width: number, height: number, options: RenderTexture2DOptions = {}): Texture2D {
    if (width < 1 || height < 1) {
        throw new Error(`createRenderTexture2D: width/height must be >= 1 (got ${width}x${height})`);
    }
    const device = engine._device;
    const format = options.format ?? engine.format;
    const texture = device.createTexture({
        size: { width, height },
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });
    const sampler = getOrCreateSampler(engine, {
        addressModeU: options.addressModeU ?? "clamp-to-edge",
        addressModeV: options.addressModeV ?? "clamp-to-edge",
        minFilter: options.minFilter ?? "linear",
        magFilter: options.magFilter ?? "linear",
    });
    const tex: Texture2D = { texture, view: texture.createView(), sampler, width, height };
    acquireTexture(tex);
    return tex;
}

/**
 * Update a rectangular region of an existing `Texture2D` from a tightly-packed RGBA8 byte buffer.
 *
 * The texture must have been created with `COPY_DST` usage (as `createTexture2DFromPixels` does).
 * This is the runtime counterpart to `createTexture2DFromPixels` — for data textures the app mutates
 * each frame / on demand (e.g. a terrain carve heightmap stamped by a dig tool).
 *
 * @param engine - Engine context.
 * @param tex - Target texture (from `createTexture2DFromPixels`).
 * @param data - `width * height * 4` bytes for the sub-region, row-major, straight alpha.
 * @param x - Destination origin X in texels (default 0).
 * @param y - Destination origin Y in texels (default 0).
 * @param width - Region width in texels (default `tex.width`).
 * @param height - Region height in texels (default `tex.height`).
 */
export function updateTexture2DFromPixels(engine: EngineContext, tex: Texture2D, data: Uint8Array, x = 0, y = 0, width = tex.width, height = tex.height): void {
    if (width < 1 || height < 1) {
        throw new Error(`updateTexture2DFromPixels: width/height must be >= 1 (got ${width}x${height})`);
    }
    const expected = width * height * 4;
    if (data.length < expected) {
        throw new Error(`updateTexture2DFromPixels: data too short — need ${expected} bytes for ${width}x${height} RGBA, got ${data.length}`);
    }
    engine._device.queue.writeTexture(
        { texture: tex.texture, origin: { x, y } },
        data as Uint8Array<ArrayBuffer>,
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height }
    );
}
