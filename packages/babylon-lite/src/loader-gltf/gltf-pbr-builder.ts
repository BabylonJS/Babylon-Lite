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
    return { texture: tex, view: tex.createView(), sampler, width: w, height: h };
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
    const ef = mat.emissiveFactor;
    const defaultFactor = (ef[0] === 1 && ef[1] === 1 && ef[2] === 1) || (ef[0] === 0 && ef[1] === 0 && ef[2] === 0);
    return {
        baseColorTexture,
        normalTexture,
        ormTexture,
        emissiveTexture,
        doubleSided: mat.doubleSided,
        occlusionStrength: mat.occlusionImage ? 1.0 : 0,
        ...(mat.normalScale !== 1 ? { normalTextureScale: mat.normalScale } : undefined),
        ...(mat.metallicRoughnessImage ? { metallicFactor: mat.metallicFactor, roughnessFactor: mat.roughnessFactor } : undefined),
        ...(!defaultFactor ? { emissiveColor: [ef[0], ef[1], ef[2]] as [number, number, number] } : undefined),
        enableSpecularAA: true,
        ...(mat.alphaMode === "BLEND" ? { alphaBlend: true, alpha: mat.baseColorFactor[3] } : undefined),
        ...extLayers,
        _buildGroup: pbrGroupBuilder,
    } satisfies PbrMaterialPropsInternal;
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
    const baseColorTexture = mat.baseColorImage
        ? getCachedTex(mat.baseColorImage, true)
        : (() => {
              const f = mat.baseColorFactor;
              return uploadTex(
                  engine,
                  null,
                  true,
                  sampler,
                  generateMipmaps,
                  new Uint8Array([linearToSrgbByte(f[0]), linearToSrgbByte(f[1]), linearToSrgbByte(f[2]), Math.round(Math.max(0, Math.min(1, f[3])) * 255)])
              );
          })();
    const normalTexture = mat.normalImage ? getCachedTex(mat.normalImage, false) : undefined;
    const emissiveTexture = mat.emissiveImage ? getCachedTex(mat.emissiveImage, true) : undefined;

    const single = mat.metallicRoughnessImage ?? mat.occlusionImage;
    let ormTexture: Texture2D;
    if (single && (!mat.metallicRoughnessImage || !mat.occlusionImage || mat.metallicRoughnessImage === mat.occlusionImage)) {
        ormTexture = getCachedTex(single, false);
    } else if (!single) {
        const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
        ormTexture = uploadTex(engine, null, false, sampler, generateMipmaps, new Uint8Array([255, clamp(mat.roughnessFactor), clamp(mat.metallicFactor), 255]));
    } else {
        ormTexture = getCachedTex(mat.metallicRoughnessImage!, false);
    }
    return { baseColorTexture, ormTexture, normalTexture, emissiveTexture };
}

/** Run all material-layer features and merge their fragments. */
export async function runMatExts(mat: GltfMaterialData, exts: GltfFeature[], ctx: GltfMatExtCtx): Promise<Partial<PbrMaterialProps> | undefined> {
    if (exts.length === 0) {
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
