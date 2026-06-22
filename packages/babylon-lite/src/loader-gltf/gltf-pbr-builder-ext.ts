/** Lazy-loaded slow path for PBR material assembly.
 *  Only pulled into bundles whose glTF uses features that require per-texture
 *  wrapping (e.g. KHR_texture_transform) or occlusion on UV2 (texCoord=1 with
 *  no shared MR image). Scene1 (BoomBox) and any vanilla-PBR glTF skip this
 *  module entirely. */

import { U8 } from "../engine/typed-arrays.js";
import type { EngineContext } from "../engine/engine.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { cloneTexture2D } from "../texture/texture-2d.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { pbrGroupBuilder } from "../material/pbr/pbr-material.js";
import type { GltfMaterialData } from "./gltf-material.js";
import { linearToSrgbByte } from "../math/color.js";
import type { TextureWrapFn, GenerateMipmapsFn } from "./gltf-pbr-builder.js";
import { uploadTex } from "./gltf-pbr-builder.js";

export interface PbrTexturesExt {
    baseColorTexture: Texture2D;
    ormTexture: Texture2D;
    normalTexture: Texture2D | undefined;
    emissiveTexture: Texture2D | undefined;
    occlusionTexture: Texture2D | undefined;
}

/** Stamp `_texCoord=1` on a clone when textureInfo selects UV1 and the
 *  wrapTex layer didn't already set it (i.e. scene has no KHR_texture_transform). */
function wrapTexCoord(tex: Texture2D, texInfo: unknown): Texture2D {
    if (!texInfo) {
        return tex;
    }
    if ((tex as { _texCoord?: 0 | 1 })._texCoord === 1) {
        return tex;
    }
    const ti = texInfo as { texCoord?: number; extensions?: { KHR_texture_transform?: { texCoord?: number } } };
    const tc = ti.extensions?.KHR_texture_transform?.texCoord ?? ti.texCoord;
    return tc === 1 ? cloneTexture2D(tex, { _texCoord: 1 }) : tex;
}

/** True when occlusion shares the ORM image with metallic-roughness but must be sampled
 *  with its OWN UV transform — i.e. occlusion references a distinct glTF texture object,
 *  or it carries its own KHR_texture_transform that an animation pointer can drive apart
 *  from the MR transform. Drives the orm-unpack split in buildDefaultPbrTexturesExt. */
function occlusionNeedsSplit(raw: {
    occlusionTexture?: { index?: number; extensions?: { KHR_texture_transform?: unknown } };
    pbrMetallicRoughness?: { metallicRoughnessTexture?: { index?: number } };
}): boolean {
    const occ = raw.occlusionTexture;
    const mr = raw.pbrMetallicRoughness?.metallicRoughnessTexture;
    if (!occ || !mr) {
        return false;
    }
    return occ.index !== mr.index || occ.extensions?.KHR_texture_transform != null;
}

/** Build textures with wrapTex + occlusionOnUv2 support. Mirrors master's
 *  default texture building but honors per-textureInfo wrapping so
 *  KHR_texture_transform can attach per-texture UV state. */
export function buildDefaultPbrTexturesExt(
    engine: EngineContext,
    mat: GltfMaterialData,
    sampler: GPUSampler,
    generateMipmaps: GenerateMipmapsFn,
    getCachedTex: (bitmap: ImageBitmap, srgb: boolean) => Texture2D,
    wrapTex: TextureWrapFn,
    samplerFor?: (texInfo: unknown) => GPUSampler
): PbrTexturesExt {
    const wrap: TextureWrapFn = (tex, ti) => wrapTexCoord(wrapTex(tex, ti), ti);
    // When the asset declares non-default glTF samplers, upload each texture with its own
    // sampler (wrap/filter), caching per (sampler, image, srgb) exactly like the fast-path
    // buildSampledPbrTextures. Without samplerFor (common case) reuse the shared default-
    // sampler cache. A GPUTexture is sampler-independent, so the same image with two
    // samplers yields two Texture2D wrappers, matching the fast path.
    const _localCache = samplerFor ? new Map<GPUSampler, Map<number, Texture2D>>() : null;
    const _ids = samplerFor ? new Map<ImageBitmap, number>() : null;
    let _nextId = 0;
    const pickTex = (image: ImageBitmap, srgb: boolean, texInfo: unknown): Texture2D => {
        if (!samplerFor) {
            return getCachedTex(image, srgb);
        }
        const s = samplerFor(texInfo);
        let bySampler = _localCache!.get(s);
        if (!bySampler) {
            _localCache!.set(s, (bySampler = new Map()));
        }
        let id = _ids!.get(image);
        if (id === undefined) {
            _ids!.set(image, (id = _nextId++));
        }
        const key = id * 2 + (srgb ? 1 : 0);
        let tex = bySampler.get(key);
        if (!tex) {
            tex = uploadTex(engine, image, srgb, s, generateMipmaps);
            bySampler.set(key, tex);
        }
        return tex;
    };
    const raw = mat._rawMatDef ?? {};
    const pbr = raw.pbrMetallicRoughness ?? {};
    const baseColorTexture = mat._baseColorImage
        ? wrap(pickTex(mat._baseColorImage, true, pbr.baseColorTexture), pbr.baseColorTexture)
        : (() => {
              const f = mat._baseColorFactor;
              return uploadTex(
                  engine,
                  null,
                  true,
                  sampler,
                  generateMipmaps,
                  new U8([linearToSrgbByte(f[0]), linearToSrgbByte(f[1]), linearToSrgbByte(f[2]), Math.round(Math.max(0, Math.min(1, f[3])) * 255)])
              );
          })();
    const normalTexture = mat._normalImage ? wrap(pickTex(mat._normalImage, false, raw.normalTexture), raw.normalTexture) : undefined;
    const emissiveTexture = mat._emissiveImage ? wrap(pickTex(mat._emissiveImage, true, raw.emissiveTexture), raw.emissiveTexture) : undefined;

    const occlusionOnUv2 = mat._occlusionTexCoord !== 0 && mat._occlusionImage && !mat._metallicRoughnessImage;
    let occlusionTexture: Texture2D | undefined;
    const single = mat._metallicRoughnessImage ?? (occlusionOnUv2 ? null : mat._occlusionImage);
    let ormTexture: Texture2D;
    if (occlusionOnUv2) {
        const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
        ormTexture = uploadTex(engine, null, false, sampler, generateMipmaps, new U8([255, clamp(mat._roughnessFactor), clamp(mat._metallicFactor), 255]));
        occlusionTexture = wrap(pickTex(mat._occlusionImage!, false, raw.occlusionTexture), raw.occlusionTexture);
    } else if (single && (!mat._metallicRoughnessImage || !mat._occlusionImage || mat._metallicRoughnessImage === mat._occlusionImage)) {
        const ormTi = mat._metallicRoughnessImage ? pbr.metallicRoughnessTexture : raw.occlusionTexture;
        ormTexture = wrap(pickTex(single, false, ormTi), ormTi);
    } else if (!single) {
        const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
        ormTexture = uploadTex(engine, null, false, sampler, generateMipmaps, new U8([255, clamp(mat._roughnessFactor), clamp(mat._metallicFactor), 255]));
    } else {
        ormTexture = wrap(pickTex(mat._metallicRoughnessImage!, false, pbr.metallicRoughnessTexture), pbr.metallicRoughnessTexture);
    }
    // Independent-occlusion UV transform (orm-unpack): occlusion and metallic-roughness
    // share the ORM texture (same image), but the glTF gives occlusion its OWN
    // KHR_texture_transform (or a distinct texture object) so the two can be animated
    // independently via KHR_animation_pointer. Sampling occlusion with MR's transform
    // (the single ormUV) would wrongly animate it. Build a transform-carrying occlusion
    // texture (shares the ORM GPU image) so the shader can sample occlusion with occlUV.
    // Requires the same underlying image as the ORM texture, since the shader re-samples
    // ormTexture at occlUV.
    if (!occlusionTexture && mat._occlusionImage && mat._occlusionImage === mat._metallicRoughnessImage && occlusionNeedsSplit(raw)) {
        occlusionTexture = wrap(pickTex(mat._occlusionImage, false, raw.occlusionTexture), raw.occlusionTexture);
    }
    return { baseColorTexture, ormTexture, normalTexture, emissiveTexture, occlusionTexture };
}

/** Slow-path assembly: adds occlusionTexCoord and occlusionTexture props. */
export function assemblePbrPropsExt(mat: GltfMaterialData, tex: PbrTexturesExt, extLayers: Partial<PbrMaterialProps> | undefined): PbrMaterialProps {
    const ef = mat._emissiveFactor;
    const defaultFactor = (ef[0] === 1 && ef[1] === 1 && ef[2] === 1) || (ef[0] === 0 && ef[1] === 0 && ef[2] === 0);
    // Precompute UV-transform presence so the renderer doesn't scan 5 textures
    // per mesh. Any wrapped texture with `_hasTx=true` (set by gltf-ext-uv-transform)
    // flips this once at build time; omitted entirely on fast path.
    const hasAnyUvTx =
        !!(tex.baseColorTexture as { _hasTx?: true })._hasTx ||
        !!(tex.normalTexture as { _hasTx?: true } | undefined)?._hasTx ||
        !!(tex.ormTexture as { _hasTx?: true })._hasTx ||
        !!(tex.emissiveTexture as { _hasTx?: true } | undefined)?._hasTx ||
        !!(tex.occlusionTexture as { _hasTx?: true } | undefined)?._hasTx;
    return {
        baseColorTexture: tex.baseColorTexture,
        normalTexture: tex.normalTexture,
        ormTexture: tex.ormTexture,
        emissiveTexture: tex.emissiveTexture,
        ...(mat._baseColorImage && !isDefaultBaseColorFactor(mat._baseColorFactor) ? { baseColorFactor: mat._baseColorFactor } : undefined),
        doubleSided: mat._doubleSided,
        occlusionStrength: mat._occlusionImage ? 1.0 : 0,
        ...(mat._occlusionTexCoord ? { occlusionTexCoord: mat._occlusionTexCoord } : undefined),
        ...(tex.occlusionTexture ? { occlusionTexture: tex.occlusionTexture } : undefined),
        ...(mat._normalScale !== 1 ? { normalTextureScale: mat._normalScale } : undefined),
        ...(mat._metallicRoughnessImage ? { metallicFactor: mat._metallicFactor, roughnessFactor: mat._roughnessFactor } : undefined),
        ...(!defaultFactor ? { emissiveColor: [ef[0], ef[1], ef[2]] as [number, number, number] } : undefined),
        enableSpecularAA: true,
        ...(mat._alphaMode === "BLEND" ? { alphaBlend: true, alpha: mat._baseColorFactor[3] } : undefined),
        ...(mat._alphaMode === "MASK" ? { alpha: mat._baseColorFactor[3], alphaCutOff: mat._alphaCutoff } : undefined),
        ...(hasAnyUvTx ? { _hasUvTx: true } : undefined),
        ...(mat._rawMatDef?.name ? { name: mat._rawMatDef.name as string } : undefined),
        ...extLayers,
        _buildGroup: pbrGroupBuilder,
        _uboVersion: 0,
    } as PbrMaterialProps;
}

function isDefaultBaseColorFactor(f: readonly number[]): boolean {
    return f[0] === 1 && f[1] === 1 && f[2] === 1 && f[3] === 1;
}
