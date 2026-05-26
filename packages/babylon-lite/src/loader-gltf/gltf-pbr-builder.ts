/** Shared PBR-material assembly + texture upload + ext-layer merging.
 *  Used by both the core loader (`load-gltf.ts`) and the variants loader
 *  (`gltf-variants.ts`) so they can't drift. */

import type { EngineContextInternal } from "../engine/engine.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { PbrMaterialProps, PbrMaterialPropsInternal } from "../material/pbr/pbr-material.js";
import { pbrGroupBuilder } from "../material/pbr/pbr-material.js";
import type { GltfMaterialData, GltfMatExtCtx } from "./gltf-material.js";
import type { GltfFeature } from "./gltf-feature.js";
import { mipLevelCount } from "../texture/mip-count.js";
import { linearToSrgbByte } from "../color/color.js";

/** Texture post-processor composed from every active feature's `wrapTexture`
 *  hook. Identity when no feature contributes one (common case). Kept simple
 *  so the core loader stays feature-agnostic and tree-shakes cleanly. */
export type TextureWrapFn = (tex: Texture2D, texInfo: unknown) => Texture2D;
export const identityTexWrap: TextureWrapFn = (tex) => tex;

export type GenerateMipmapsFn = (engine: EngineContextInternal, texture: GPUTexture, face?: number) => void;

export function uploadTex(
    engine: EngineContextInternal,
    bitmap: ImageBitmap | null,
    srgb: boolean,
    sampler: GPUSampler,
    generateMipmaps: GenerateMipmapsFn,
    fallback?: Uint8Array
): Texture2D {
    const device = engine.device;
    const w = bitmap?.width ?? 1;
    const h = bitmap?.height ?? 1;
    const fmt: GPUTextureFormat = srgb ? "rgba8unorm-srgb" : "rgba8unorm";
    const mips = bitmap ? mipLevelCount(w, h) : 1;
    const tex = device.createTexture({
        size: { width: w, height: h },
        format: fmt,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
        mipLevelCount: mips,
    });
    if (bitmap) {
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: tex, premultipliedAlpha: false }, { width: w, height: h });
        generateMipmaps(engine, tex);
    } else {
        device.queue.writeTexture({ texture: tex }, (fallback ?? new Uint8Array([255, 255, 255, 255])) as Uint8Array<ArrayBuffer>, { bytesPerRow: 4 }, { width: 1, height: 1 });
    }
    const result: Texture2D = {
        texture: tex,
        view: tex.createView(),
        sampler,
        width: w,
        height: h,
    };
    engine._dlr?.b(result, bitmap, srgb, !!bitmap, fallback);
    return result;
}

/** Assemble a PbrMaterialPropsInternal from parsed glTF material data + already-uploaded
 *  textures + per-ext fragment overrides. Fast-path: no wrapTex, no occlusionOnUv2,
 *  no occlusionTexture. Slow-path additions live in gltf-pbr-builder-ext.ts. */
export function assemblePbrProps(
    mat: GltfMaterialData,
    baseColorTexture: Texture2D,
    ormTexture: Texture2D,
    normalTexture: Texture2D | undefined,
    emissiveTexture: Texture2D | undefined,
    extLayers: Partial<PbrMaterialProps> | undefined
): PbrMaterialPropsInternal {
    const ef = mat._emissiveFactor;
    const defaultFactor = (ef[0] === 1 && ef[1] === 1 && ef[2] === 1) || (ef[0] === 0 && ef[1] === 0 && ef[2] === 0);
    return {
        baseColorTexture,
        normalTexture,
        ormTexture,
        emissiveTexture,
        doubleSided: mat._doubleSided,
        occlusionStrength: mat._occlusionImage ? 1.0 : 0,
        ...(mat._normalScale !== 1 ? { normalTextureScale: mat._normalScale } : undefined),
        ...(mat._metallicRoughnessImage ? { metallicFactor: mat._metallicFactor, roughnessFactor: mat._roughnessFactor } : undefined),
        ...(!defaultFactor ? { emissiveColor: [ef[0], ef[1], ef[2]] as [number, number, number] } : undefined),
        enableSpecularAA: true,
        ...(mat._alphaMode === "BLEND" ? { alphaBlend: true, alpha: mat._baseColorFactor[3] } : undefined),
        ...(mat._alphaMode === "MASK" ? { alpha: mat._baseColorFactor[3], alphaCutOff: mat._alphaCutoff } : undefined),
        ...extLayers,
        _buildGroup: pbrGroupBuilder,
        _uboVersion: 0,
    } as PbrMaterialPropsInternal;
}

/** Build the always-present default textures (base color + ORM) from a parsed glTF material.
 *  Fast-path version: no wrapTex, no occlusion-on-uv2 handling. The slow path lives
 *  in gltf-pbr-builder-ext.ts and is lazy-loaded only when needed. */
export function buildDefaultPbrTextures(
    engine: EngineContextInternal,
    mat: GltfMaterialData,
    sampler: GPUSampler,
    generateMipmaps: GenerateMipmapsFn,
    getCachedTex: (bitmap: ImageBitmap, srgb: boolean) => Texture2D
): { baseColorTexture: Texture2D; ormTexture: Texture2D; normalTexture: Texture2D | undefined; emissiveTexture: Texture2D | undefined } {
    const baseColorTexture = mat._baseColorImage
        ? getCachedTex(mat._baseColorImage, true)
        : (() => {
              const f = mat._baseColorFactor;
              return uploadTex(
                  engine,
                  null,
                  true,
                  sampler,
                  generateMipmaps,
                  new Uint8Array([linearToSrgbByte(f[0]), linearToSrgbByte(f[1]), linearToSrgbByte(f[2]), Math.round(Math.max(0, Math.min(1, f[3])) * 255)])
              );
          })();
    const normalTexture = mat._normalImage ? getCachedTex(mat._normalImage, false) : undefined;
    const emissiveTexture = mat._emissiveImage ? getCachedTex(mat._emissiveImage, true) : undefined;

    const single = mat._metallicRoughnessImage ?? mat._occlusionImage;
    let ormTexture: Texture2D;
    if (single && (!mat._metallicRoughnessImage || !mat._occlusionImage || mat._metallicRoughnessImage === mat._occlusionImage)) {
        ormTexture = getCachedTex(single, false);
    } else if (!single) {
        const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
        ormTexture = uploadTex(engine, null, false, sampler, generateMipmaps, new Uint8Array([255, clamp(mat._roughnessFactor), clamp(mat._metallicFactor), 255]));
    } else {
        ormTexture = getCachedTex(mat._metallicRoughnessImage!, false);
    }
    return { baseColorTexture, ormTexture, normalTexture, emissiveTexture };
}

/** Run all material-layer features and merge their fragments. */
export async function runMatExts(mat: GltfMaterialData, exts: GltfFeature[], ctx: GltfMatExtCtx): Promise<Partial<PbrMaterialProps> | undefined> {
    if (!exts.length) {
        return undefined;
    }
    const fragments = await Promise.all(exts.map((ext) => ext.applyMaterial!(mat, ctx)));
    let layers: Partial<PbrMaterialProps> | undefined;
    for (const f of fragments) {
        if (f) {
            layers ??= {};
            Object.assign(layers, f);
        }
    }
    return layers;
}
