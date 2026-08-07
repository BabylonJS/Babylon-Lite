/** Shared PBR-material assembly + texture upload + ext-layer merging.
 *  Used by both the core loader (`load-gltf.ts`) and the variants loader
 *  (`gltf-variants.ts`) so they can't drift. */

import { U8 } from "../engine/typed-arrays.js";
import { TU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { getPbrGroupBuilder } from "../material/pbr/pbr-material.js";
import type { GltfMaterialData } from "./gltf-material.js";
import { mipLevelCount } from "../texture/mip-count.js";
import { linearToSrgbByte } from "../math/color.js";

/** Texture post-processor composed from every active feature's `wrapTexture`
 *  hook. Identity when no feature contributes one (common case). Kept simple
 *  so the core loader stays feature-agnostic and tree-shakes cleanly. */
export type TextureWrapFn = (tex: Texture2D, texInfo: unknown) => Texture2D;
export const identityTexWrap: TextureWrapFn = (tex) => tex;

export type GenerateMipmapsFn = (engine: EngineContext, texture: GPUTexture, face?: number) => void;

export function uploadTex(
    engine: EngineContext,
    bitmap: ImageBitmap | null,
    srgb: boolean,
    sampler: GPUSampler,
    generateMipmaps: GenerateMipmapsFn,
    fallback?: Uint8Array
): Texture2D {
    const device = engine._device;
    const w = bitmap?.width ?? 1;
    const h = bitmap?.height ?? 1;
    const fmt: GPUTextureFormat = srgb ? "rgba8unorm-srgb" : "rgba8unorm";
    const mips = bitmap ? mipLevelCount(w, h) : 1;
    const tex = device.createTexture({
        size: { width: w, height: h },
        format: fmt,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.COPY_SRC | TU.RENDER_ATTACHMENT,
        mipLevelCount: mips,
    });
    if (bitmap) {
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: tex, premultipliedAlpha: false }, { width: w, height: h });
        generateMipmaps(engine, tex);
    } else {
        device.queue.writeTexture({ texture: tex }, (fallback ?? new U8([255, 255, 255, 255])) as Uint8Array<ArrayBuffer>, { bytesPerRow: 4 }, { width: 1, height: 1 });
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

export function uploadBaseColorFactorTexture(engine: EngineContext, factor: readonly number[], sampler: GPUSampler, generateMipmaps: GenerateMipmapsFn): Texture2D {
    return uploadTex(
        engine,
        null,
        true,
        sampler,
        generateMipmaps,
        new U8([linearToSrgbByte(factor[0]!), linearToSrgbByte(factor[1]!), linearToSrgbByte(factor[2]!), Math.round(Math.max(0, Math.min(1, factor[3]!)) * 255)])
    );
}

export function uploadOrmFactorTexture(engine: EngineContext, roughness: number, metallic: number, sampler: GPUSampler, generateMipmaps: GenerateMipmapsFn): Texture2D {
    const clamp = (value: number): number => Math.round(Math.max(0, Math.min(1, value)) * 255);
    return uploadTex(engine, null, false, sampler, generateMipmaps, new U8([255, clamp(roughness), clamp(metallic), 255]));
}

/** True when a glTF material's `emissiveFactor` describes a real emissive that has to be
 *  applied via `setPbrEmissive`.
 *
 *  Deliberately a standalone predicate rather than logic inside the assemble functions:
 *  `setPbrEmissive` statically imports the emissive fragment, so any *static* import of it
 *  from this always-loaded module bundles that fragment into every glTF scene, emissive or
 *  not. (It did — 74 scenes carried ~513 B of emissive fragment for ~9 real users.) Callers
 *  own the conditional `import("../material/pbr/set-emissive.js")`, mirroring how alpha-test
 *  and the dielectric extensions are gated.
 *
 *  `emissiveFactor` multiplies the emissive texture, so [1,1,1] is a no-op WHEN a texture is
 *  present. With no emissive texture, [1,1,1] is a real full-white emissive that must be
 *  applied (the glTF default is [0,0,0]) — otherwise the surface renders unlit/dark
 *  (Material_03). Callers must additionally skip when `props._emissiveColor` is already set:
 *  KHR_materials_emissive_strength arrives via `extLayers` having already called the setter
 *  with the strength-scaled value, and that takes precedence over the raw factor. */
export function needsGltfEmissive(mat: GltfMaterialData, emissiveTexture: Texture2D | undefined): boolean {
    const ef = mat._emissiveFactor;
    return !((ef[0] === 0 && ef[1] === 0 && ef[2] === 0) || (!!emissiveTexture && ef[0] === 1 && ef[1] === 1 && ef[2] === 1));
}

/** Assemble a PbrMaterialProps from parsed glTF material data + already-uploaded
 *  textures + per-ext fragment overrides. Fast-path: no wrapTex, no occlusionOnUv2,
 *  no occlusionTexture. Slow-path additions live in gltf-pbr-builder-ext.ts.
 *  Emissive is applied by the caller — see `needsGltfEmissive`. */
export function assemblePbrProps(
    mat: GltfMaterialData,
    baseColorTexture: Texture2D,
    ormTexture: Texture2D,
    normalTexture: Texture2D | undefined,
    emissiveTexture: Texture2D | undefined,
    extLayers: Partial<PbrMaterialProps> | undefined
): PbrMaterialProps {
    const props = {
        baseColorTexture,
        normalTexture,
        ormTexture,
        emissiveTexture,
        ...(mat._baseColorImage && !isDefaultBaseColorFactor(mat._baseColorFactor) ? { baseColorFactor: mat._baseColorFactor } : undefined),
        doubleSided: mat._doubleSided,
        occlusionStrength: mat._occlusionImage ? 1.0 : 0,
        ...(mat._normalScale !== 1 ? { normalTextureScale: mat._normalScale } : undefined),
        ...(mat._metallicRoughnessImage ? { metallicFactor: mat._metallicFactor, roughnessFactor: mat._roughnessFactor } : undefined),
        enableSpecularAA: true,
        ...(mat._alphaMode === "BLEND" ? { alphaBlend: true, alpha: mat._baseColorFactor[3] } : undefined),
        ...(mat._alphaMode === "MASK" ? { alpha: mat._baseColorFactor[3] } : undefined),
        ...(mat._rawMatDef?.name ? { name: mat._rawMatDef.name as string } : undefined),
        ...extLayers,
        _buildGroup: getPbrGroupBuilder(),
        _uboVersion: 0,
    } as PbrMaterialProps;
    return props;
}

function isDefaultBaseColorFactor(f: readonly number[]): boolean {
    return f[0] === 1 && f[1] === 1 && f[2] === 1 && f[3] === 1;
}

/** Build the always-present default textures (base color + ORM) from a parsed glTF material.
 *  Fast-path version: no wrapTex, no occlusion-on-uv2 handling. The slow path lives
 *  in gltf-pbr-builder-ext.ts and is lazy-loaded only when needed. */
export function buildDefaultPbrTextures(
    engine: EngineContext,
    mat: GltfMaterialData,
    sampler: GPUSampler,
    generateMipmaps: GenerateMipmapsFn,
    getCachedTex: (bitmap: ImageBitmap, srgb: boolean) => Texture2D
): { baseColorTexture: Texture2D; ormTexture: Texture2D; normalTexture: Texture2D | undefined; emissiveTexture: Texture2D | undefined } {
    const baseColorTexture = mat._baseColorImage ? getCachedTex(mat._baseColorImage, true) : uploadBaseColorFactorTexture(engine, mat._baseColorFactor, sampler, generateMipmaps);
    const normalTexture = mat._normalImage ? getCachedTex(mat._normalImage, false) : undefined;
    const emissiveTexture = mat._emissiveImage ? getCachedTex(mat._emissiveImage, true) : undefined;

    const single = mat._metallicRoughnessImage ?? mat._occlusionImage;
    let ormTexture: Texture2D;
    if (single && (!mat._metallicRoughnessImage || !mat._occlusionImage || mat._metallicRoughnessImage === mat._occlusionImage)) {
        ormTexture = getCachedTex(single, false);
    } else if (!single) {
        ormTexture = uploadOrmFactorTexture(engine, mat._roughnessFactor, mat._metallicFactor, sampler, generateMipmaps);
    } else {
        ormTexture = getCachedTex(mat._metallicRoughnessImage!, false);
    }
    return { baseColorTexture, ormTexture, normalTexture, emissiveTexture };
}
