/** Lazy-loaded slow path for PBR material assembly.
 *  Only pulled into bundles whose glTF uses features that require per-texture
 *  wrapping (e.g. KHR_texture_transform) or occlusion on UV2 (texCoord=1 with
 *  no shared MR image). Scene1 (BoomBox) and any vanilla-PBR glTF skip this
 *  module entirely. */

import type { EngineContextInternal } from "../engine/engine.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { cloneTexture2D } from "../texture/texture-2d.js";
import type { PbrMaterialProps, PbrMaterialPropsInternal } from "../material/pbr/pbr-material.js";
import { pbrGroupBuilder } from "../material/pbr/pbr-material.js";
import type { GltfMaterialData } from "./gltf-material.js";
import { linearToSrgbByte } from "../color/color.js";
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

/** Build textures with wrapTex + occlusionOnUv2 support. Mirrors master's
 *  default texture building but honors per-textureInfo wrapping so
 *  KHR_texture_transform can attach per-texture UV state. */
export function buildDefaultPbrTexturesExt(
    engine: EngineContextInternal,
    mat: GltfMaterialData,
    sampler: GPUSampler,
    generateMipmaps: GenerateMipmapsFn,
    getCachedTex: (bitmap: ImageBitmap, srgb: boolean) => Texture2D,
    wrapTex: TextureWrapFn
): PbrTexturesExt {
    const wrap: TextureWrapFn = (tex, ti) => wrapTexCoord(wrapTex(tex, ti), ti);
    const raw = mat._rawMatDef ?? {};
    const pbr = raw.pbrMetallicRoughness ?? {};
    const baseColorTexture = mat._baseColorImage
        ? wrap(getCachedTex(mat._baseColorImage, true), pbr.baseColorTexture)
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
    const normalTexture = mat._normalImage ? wrap(getCachedTex(mat._normalImage, false), raw.normalTexture) : undefined;
    const emissiveTexture = mat._emissiveImage ? wrap(getCachedTex(mat._emissiveImage, true), raw.emissiveTexture) : undefined;

    const occlusionOnUv2 = mat._occlusionTexCoord !== 0 && mat._occlusionImage && !mat._metallicRoughnessImage;
    let occlusionTexture: Texture2D | undefined;
    const single = mat._metallicRoughnessImage ?? (occlusionOnUv2 ? null : mat._occlusionImage);
    let ormTexture: Texture2D;
    if (occlusionOnUv2) {
        const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
        ormTexture = uploadTex(engine, null, false, sampler, generateMipmaps, new Uint8Array([255, clamp(mat._roughnessFactor), clamp(mat._metallicFactor), 255]));
        occlusionTexture = wrap(getCachedTex(mat._occlusionImage!, false), raw.occlusionTexture);
    } else if (single && (!mat._metallicRoughnessImage || !mat._occlusionImage || mat._metallicRoughnessImage === mat._occlusionImage)) {
        const ormTi = mat._metallicRoughnessImage ? pbr.metallicRoughnessTexture : raw.occlusionTexture;
        ormTexture = wrap(getCachedTex(single, false), ormTi);
    } else if (!single) {
        const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
        ormTexture = uploadTex(engine, null, false, sampler, generateMipmaps, new Uint8Array([255, clamp(mat._roughnessFactor), clamp(mat._metallicFactor), 255]));
    } else {
        ormTexture = wrap(getCachedTex(mat._metallicRoughnessImage!, false), pbr.metallicRoughnessTexture);
    }
    return { baseColorTexture, ormTexture, normalTexture, emissiveTexture, occlusionTexture };
}

/** Slow-path assembly: adds occlusionTexCoord and occlusionTexture props. */
export function assemblePbrPropsExt(mat: GltfMaterialData, tex: PbrTexturesExt, extLayers: Partial<PbrMaterialProps> | undefined): PbrMaterialPropsInternal {
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
        ...extLayers,
        _buildGroup: pbrGroupBuilder,
        _uboVersion: 0,
    } as PbrMaterialPropsInternal;
}
