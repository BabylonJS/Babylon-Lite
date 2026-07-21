import { U8 } from "../engine/typed-arrays.js";
import { TU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { Texture2D, Texture2DOptions } from "./texture-2d.js";
import { getOrCreateSampler } from "../resource/gpu-pool.js";
import { getBilinearSampler } from "../resource/samplers.js";

/**
 * Rebuilds a single Texture2D after a WebGPU device loss from the pure recovery
 * data stamped on `tex._recoverySource`.
 *
 * This module is reached only through a lazy `await import()` on the recovery
 * path in device-lost-recovery, so the always-bundled recovery orchestrator
 * carries none of the per-kind texture rebuild logic (url/solid/dynamic/bitmap)
 * statically. A scene that enables device-lost recovery pays for this code only
 * if an actual device loss occurs, and the dynamic-texture rebuild remains in a
 * further on-demand chunk so recovery scenes that never create a dynamic texture
 * never load it.
 */
export async function rebuildTexture2D(engine: EngineContext, tex: Texture2D): Promise<void> {
    const source = tex._recoverySource;
    if (!source) {
        return;
    }
    if (source.kind === "url") {
        const rebuilt = await rebuildUrlTexture2D(engine, source.url, source.opts);
        tex.texture = rebuilt.texture;
        tex.view = rebuilt.view;
        tex.sampler = rebuilt.sampler;
        tex.width = rebuilt.width;
        tex.height = rebuilt.height;
        tex._recoverySource = source;
        return;
    }
    if (source.kind === "solid") {
        const texture = engine._device.createTexture({ size: { width: 1, height: 1 }, format: "rgba8unorm", usage: TU.TEXTURE_BINDING | TU.COPY_DST });
        const data = new U8(source.rgba.map((v) => Math.round(v * 255)));
        engine._device.queue.writeTexture({ texture }, data, { bytesPerRow: 4, rowsPerImage: 1 }, { width: 1, height: 1 });
        tex.texture = texture;
        tex.view = texture.createView();
        tex.sampler = getBilinearSampler(engine);
        tex.width = 1;
        tex.height = 1;
        return;
    }
    if (source.kind === "dynamic") {
        // Keep the dynamic-texture rebuild in a further on-demand chunk so a
        // recovery scene that never creates a dynamic texture never loads it.
        const { rebuildDynamicTexture2D } = await import("./dynamic-texture-recovery.js");
        await rebuildDynamicTexture2D(engine, tex);
        return;
    }
    const width = source.bitmap?.width ?? 1;
    const height = source.bitmap?.height ?? 1;
    const format: GPUTextureFormat = source.srgb ? "rgba8unorm-srgb" : "rgba8unorm";
    const mipLevelCount = source.mipMaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
    const texture = engine._device.createTexture({
        size: { width, height },
        format,
        mipLevelCount,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.COPY_SRC | TU.RENDER_ATTACHMENT,
    });
    if (source.bitmap) {
        engine._device.queue.copyExternalImageToTexture({ source: source.bitmap }, { texture, premultipliedAlpha: false }, { width, height });
        if (source.mipMaps && mipLevelCount > 1) {
            const { generateMipmaps } = await import("./generate-mipmaps.js");
            generateMipmaps(engine, texture);
        }
    } else {
        engine._device.queue.writeTexture({ texture }, (source.fallback ?? new U8([255, 255, 255, 255])) as Uint8Array<ArrayBuffer>, { bytesPerRow: 4 }, { width: 1, height: 1 });
    }
    tex.texture = texture;
    tex.view = texture.createView();
    tex.sampler = getOrCreateSampler(engine, source.samplerDesc);
    tex.width = width;
    tex.height = height;
}

async function rebuildUrlTexture2D(engine: EngineContext, url: string, opts: Texture2DOptions): Promise<Texture2D> {
    const mipMaps = opts.mipMaps ?? true;
    const addressModeU = opts.addressModeU ?? "repeat";
    const addressModeV = opts.addressModeV ?? "repeat";
    const invertY = opts.invertY ?? true;
    const srgb = opts.srgb ?? false;
    const premultiplyAlpha = opts.premultiplyAlpha ?? false;
    const format: GPUTextureFormat = srgb ? "rgba8unorm-srgb" : "rgba8unorm";

    const response = await fetch(url);
    const blob = await response.blob();
    const imageBitmap = await createImageBitmap(blob, {
        premultiplyAlpha: premultiplyAlpha ? "premultiply" : "none",
        colorSpaceConversion: "none",
    });

    const width = imageBitmap.width;
    const height = imageBitmap.height;
    const mipLevelCount = mipMaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
    const texture = engine._device.createTexture({
        size: { width, height },
        format,
        mipLevelCount,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.RENDER_ATTACHMENT,
    });
    engine._device.queue.copyExternalImageToTexture({ source: imageBitmap, flipY: invertY }, { texture, premultipliedAlpha: premultiplyAlpha }, { width, height });
    imageBitmap.close();

    if (mipMaps && mipLevelCount > 1) {
        const { generateMipmaps } = await import("./generate-mipmaps.js");
        generateMipmaps(engine, texture);
    }

    const minF = opts.minFilter ?? "linear";
    const magF = opts.magFilter ?? "linear";
    const mipF: GPUMipmapFilterMode = mipMaps ? "linear" : "nearest";
    const allLinear = minF === "linear" && magF === "linear" && mipF === "linear";
    const sampler = getOrCreateSampler(engine, {
        addressModeU,
        addressModeV,
        minFilter: minF,
        magFilter: magF,
        mipmapFilter: mipF,
        maxAnisotropy: allLinear ? 4 : 1,
    });

    return { texture, view: texture.createView(), sampler, width, height };
}
