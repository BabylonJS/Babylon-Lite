import { getOrCreateSampler } from "../resource/gpu-pool.js";
import { U8 } from "../engine/typed-arrays.js";
import { linearToSrgbByte } from "../math/color.js";
import { uploadTex } from "./gltf-pbr-builder.js";
import type { GenerateMipmapsFn } from "./gltf-pbr-builder.js";
import type { EngineContext } from "../engine/engine.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { GltfMaterialData } from "./gltf-material.js";

/** Map a glTF textureInfo's sampler (wrapS/wrapT/magFilter/minFilter) to a WebGPU sampler
 *  descriptor. glTF wrap: 33071 CLAMP_TO_EDGE, 33648 MIRRORED_REPEAT, else REPEAT.
 *  glTF filter: 9728 NEAREST else LINEAR; min/mip from the combined min filter enum. */
function gltfTexSamplerDesc(json: any, texInfo: any): GPUSamplerDescriptor {
    const s = json.textures?.[texInfo.index]?.sampler != null ? json.samplers?.[json.textures[texInfo.index].sampler] : undefined;
    const wrap = (m: number | undefined): GPUAddressMode => (m === 33071 ? "clamp-to-edge" : m === 33648 ? "mirror-repeat" : "repeat");
    const minF: number | undefined = s?.minFilter;
    const minNearest = minF === 9728 || minF === 9984 || minF === 9986;
    const mipNearest = minF === 9984 || minF === 9985;
    // glTF non-mipmap min filters (9728 NEAREST, 9729 LINEAR) mean "sample mip 0 only".
    // The shared uploaded GPU texture always carries a full mip chain, so clamp the LOD
    // to 0 for these filters (matching BJS `noMipmap`); otherwise a minified texture
    // (e.g. small SDF text in a top-down view) would sample blurred mips and render
    // softer/darker than BJS. Mipmapped filters (9984–9987) leave LOD unclamped.
    const noMip = minF === 9728 || minF === 9729;
    const magLinear = s?.magFilter !== 9728;
    return {
        magFilter: magLinear ? "linear" : "nearest",
        minFilter: minNearest ? "nearest" : "linear",
        mipmapFilter: mipNearest ? "nearest" : "linear",
        addressModeU: wrap(s?.wrapS),
        addressModeV: wrap(s?.wrapT),
        ...(noMip ? { lodMaxClamp: 0 } : undefined),
        // WebGPU forbids anisotropy unless mag/min/mip filters are ALL linear; gate on
        // every filter (incl. mipNearest, e.g. glTF LINEAR_MIPMAP_NEAREST) or createSampler throws.
        // Also disable it for the clamped-mip path (single LOD → anisotropy is meaningless).
        maxAnisotropy: magLinear && !minNearest && !mipNearest && !noMip ? 4 : 1,
    };
}

/** Build a per-texture sampler resolver honoring each texture's glTF sampler
 *  (wrap/filter). Loaded lazily only when an asset declares a non-default sampler;
 *  the common case (default repeat/linear) uses one shared sampler and never loads this.
 *  `texInfo == null` (factor textures) falls back to `defaultSampler`.
 *  @internal */
export function makeSamplerFor(engine: EngineContext, json: any, defaultSampler: GPUSampler): (texInfo: any) => GPUSampler {
    return (texInfo: any): GPUSampler => {
        if (texInfo == null) {
            return defaultSampler;
        }
        const desc = gltfTexSamplerDesc(json, texInfo);
        // A non-mipmap sampler (lodMaxClamp 0) is created directly: the shared cache key omits
        // the LOD clamp, so caching it there could alias a full-mip sampler with identical
        // filter/wrap. These are rare (SDF/UI textures), so per-call creation is cheaper than
        // growing the universal sampler key — which would move every non-glTF scene's bundle.
        return desc.lodMaxClamp === 0 ? engine._device.createSampler(desc) : getOrCreateSampler(engine, desc);
    };
}

/** Sampler-aware variant of buildDefaultPbrTextures. Mirrors the core fast path but wraps
 *  each shared GPU texture with the sampler resolved from its glTF textureInfo (wrap/filter),
 *  so clamp/mirror/nearest assets render correctly without re-uploading identical images.
 *  Lazy-loaded only for non-default-sampler assets — the common path stays byte-identical.
 *  @internal */
export function buildSampledPbrTextures(
    engine: EngineContext,
    mat: GltfMaterialData,
    defaultSampler: GPUSampler,
    generateMipmaps: GenerateMipmapsFn,
    samplerFor: (texInfo: any) => GPUSampler,
    getCachedTex: (bitmap: ImageBitmap, srgb: boolean) => Texture2D
): { baseColorTexture: Texture2D; ormTexture: Texture2D; normalTexture: Texture2D | undefined; emissiveTexture: Texture2D | undefined } {
    const def = mat._rawMatDef ?? {};
    const pbr = def.pbrMetallicRoughness ?? {};
    const cached = (bitmap: ImageBitmap, srgb: boolean, texInfo: any): Texture2D => {
        const s = samplerFor(texInfo);
        const tex = getCachedTex(bitmap, srgb);
        return s === defaultSampler ? tex : { ...tex, sampler: s };
    };

    const baseColorTexture = mat._baseColorImage
        ? cached(mat._baseColorImage, true, pbr.baseColorTexture)
        : (() => {
              const f = mat._baseColorFactor;
              return uploadTex(
                  engine,
                  null,
                  true,
                  defaultSampler,
                  generateMipmaps,
                  new U8([linearToSrgbByte(f[0]), linearToSrgbByte(f[1]), linearToSrgbByte(f[2]), Math.round(Math.max(0, Math.min(1, f[3])) * 255)])
              );
          })();
    const normalTexture = mat._normalImage ? cached(mat._normalImage, false, def.normalTexture) : undefined;
    const emissiveTexture = mat._emissiveImage ? cached(mat._emissiveImage, true, def.emissiveTexture) : undefined;

    const single = mat._metallicRoughnessImage ?? mat._occlusionImage;
    const ormTexInfo = mat._metallicRoughnessImage ? pbr.metallicRoughnessTexture : def.occlusionTexture;
    let ormTexture: Texture2D;
    if (single && (!mat._metallicRoughnessImage || !mat._occlusionImage || mat._metallicRoughnessImage === mat._occlusionImage)) {
        ormTexture = cached(single, false, ormTexInfo);
    } else if (!single) {
        const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
        ormTexture = uploadTex(engine, null, false, defaultSampler, generateMipmaps, new U8([255, clamp(mat._roughnessFactor), clamp(mat._metallicFactor), 255]));
    } else {
        ormTexture = cached(mat._metallicRoughnessImage!, false, pbr.metallicRoughnessTexture);
    }
    return { baseColorTexture, ormTexture, normalTexture, emissiveTexture };
}
