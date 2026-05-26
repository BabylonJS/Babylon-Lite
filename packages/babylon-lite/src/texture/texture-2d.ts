/**
 * 2D Texture loader — loads an image from URL into a GPU texture.
 *
 * Supports:
 * - rgba8unorm format (standard for diffuse/albedo textures)
 * - Automatic mipmap generation via copyExternalImageToTexture
 * - UV scaling via a texture matrix
 */

import { acquireTexture, getOrCreateSampler } from "../resource/gpu-pool.js";
import type { EngineContext } from "../engine/engine.js";
import type { EngineContextInternal } from "../engine/engine.js";

export interface Texture2D {
    texture: GPUTexture;
    view: GPUTextureView;
    sampler: GPUSampler;
    width: number;
    height: number;
    /** Per-texture UV transform fields. All optional; defaults make identity.
     *  Match BJS Texture.uScale/vScale/uOffset/vOffset/uAng semantics. These
     *  fields are **build-time**: they are sampled when a material pipeline
     *  is first compiled. Mutating them after the pipeline is built requires
     *  a material rebuild (flag-based rebuild path). If a cached texture
     *  wrapper needs a different transform than another use site, create a
     *  fresh wrapper via `cloneTexture2D()`. */
    uScale?: number;
    vScale?: number;
    uOffset?: number;
    vOffset?: number;
    /** Rotation in radians around the (0,0) UV corner. */
    uAng?: number;
    /** True if the texel data is stored with origin at the top (y-down) and
     *  must be flipped in V when sampled with standard (y-up) UVs. Applied at
     *  UV-transform time in the material, so compressed-format textures (where
     *  in-place row flipping is impractical) remain correct. */
    invertY?: boolean;
    /** @internal Depth textures require texture_depth_2d shader bindings. */
    _sampleType?: "float" | "depth";
    /** @internal Retained source for opt-in device-lost recovery. */
    _recoverySource?: Texture2DRecoverySource;
}

export type Texture2DRecoverySource =
    | { kind: "url"; url: string; opts: Texture2DOptions }
    | { kind: "solid"; rgba: readonly [number, number, number, number] }
    | { kind: "bitmap"; bitmap: ImageBitmap | null; srgb: boolean; mipMaps: boolean; fallback?: Uint8Array; samplerDesc: GPUSamplerDescriptor };

/** Create a fresh Texture2D wrapper that shares GPU resources with `base`
 *  but carries its own UV transform. Use this when the same underlying image
 *  is referenced with different transforms (e.g. glTF KHR_texture_transform
 *  on different textureInfos pointing at the same source). The caller is
 *  responsible for acquireTexture/release pairing if the wrapper outlives
 *  the base. */
export function cloneTexture2D(
    base: Texture2D,
    transform: Partial<Pick<Texture2D, "uScale" | "vScale" | "uOffset" | "vOffset" | "uAng">> & { _texCoord?: 0 | 1; _hasTx?: true }
): Texture2D {
    return { ...base, ...transform } as Texture2D;
}

export interface Texture2DOptions {
    /** Generate mipmaps. Default true. */
    mipMaps?: boolean;
    /** Address mode U. Default 'repeat'. */
    addressModeU?: GPUAddressMode;
    /** Address mode V. Default 'repeat'. */
    addressModeV?: GPUAddressMode;
    /** Min filter. Default 'linear'. */
    minFilter?: GPUFilterMode;
    /** Mag filter. Default 'linear'. */
    magFilter?: GPUFilterMode;
    /** Flip Y axis during upload. Default true (matches Babylon.js convention). */
    invertY?: boolean;
    /** Use sRGB format (rgba8unorm-srgb). Enables hardware sRGB→linear on sample.
     *  Use for color/albedo textures in PBR workflows. Default false. */
    srgb?: boolean;
    /** Premultiply alpha at decode time. Default false (straight RGBA, matches PNG-on-disk).
     *  Set true for sprite atlases that will be rendered with a premultiplied blend pipeline
     *  (`srcFactor: ONE`); doing so produces mathematically correct soft edges and stacked
     *  translucency. */
    premultiplyAlpha?: boolean;
}

// Per-device URL cache: same (url + options) → shared Texture2D promise.
// WeakMap ensures the cache is GC'd when the device is collected.
let _tex2dCache: WeakMap<GPUDevice, Map<string, Promise<Texture2D>>> | null = null;

/** Clear the texture cache for a device, releasing cache-held refs. */
export function clearTexture2DCache(engine: EngineContextInternal): void {
    const device = engine.device;
    _tex2dCache?.delete(device);
}

export function loadTexture2D(engine: EngineContext, url: string, opts: Texture2DOptions = {}): Promise<Texture2D> {
    const device = (engine as EngineContextInternal).device;
    if (!_tex2dCache) {
        _tex2dCache = new WeakMap();
    }
    let dc = _tex2dCache.get(device);
    if (!dc) {
        dc = new Map();
        _tex2dCache.set(device, dc);
    }

    const key = `${url}\0${opts.mipMaps ?? true}\0${opts.addressModeU ?? "repeat"}\0${opts.addressModeV ?? "repeat"}\0${opts.minFilter ?? "linear"}\0${opts.magFilter ?? "linear"}\0${opts.invertY ?? true}\0${opts.srgb ?? false}\0${opts.premultiplyAlpha ?? false}`;
    const hit = dc.get(key);
    if (hit) {
        return hit;
    }

    const map = dc;
    const p = loadTexture2DImpl(engine as EngineContextInternal, url, opts);
    map.set(key, p);
    p.catch(() => map.delete(key));
    return p;
}

async function loadTexture2DImpl(engine: EngineContextInternal, url: string, opts: Texture2DOptions): Promise<Texture2D> {
    const device = engine.device;
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

    const texture = device.createTexture({
        size: { width, height },
        format,
        mipLevelCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    device.queue.copyExternalImageToTexture({ source: imageBitmap, flipY: invertY }, { texture, premultipliedAlpha: premultiplyAlpha }, { width, height });
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

    const tex2d: Texture2D = { texture, view: texture.createView(), sampler, width, height };
    engine._dlr?.u(tex2d, url, opts);
    acquireTexture(tex2d);
    return tex2d;
}
