/**
 * glTF PBR layer extensions: KHR_materials_clearcoat, _sheen, _anisotropy.
 *
 * Dynamically imported by load-gltf.ts ONLY when a material carries one of these
 * extensions. This keeps layer-construction code out of bundles that don't use it.
 */
import type { GltfMaterialData } from "./gltf-material.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { Texture2D } from "../texture/texture-2d.js";

/** Pre-uploaded clearcoat textures supplied by the main loader. */
export interface GltfClearcoatTextures {
    ccTexture?: Texture2D;
    ccRoughnessTexture?: Texture2D;
    ccNormalTexture?: Texture2D;
}

/** Pre-uploaded sheen textures supplied by the main loader. */
export interface GltfSheenTextures {
    /** Sheen color texture (sRGB). When the glTF asset shares one image between
     *  sheenColorTexture and sheenRoughnessTexture (the canonical RGB+A packing),
     *  this single texture carries both — A channel is sampled for roughness. */
    sheenTexture?: Texture2D;
}

/** Build clearcoat / sheen / anisotropy props from parsed glTF extension data. */
export function buildPbrLayers(m: GltfMaterialData, ccTex?: GltfClearcoatTextures, shTex?: GltfSheenTextures): Partial<PbrMaterialProps> {
    const r: Partial<PbrMaterialProps> = {};
    const c = m.clearcoat;
    if (c) {
        r.clearCoat = {
            isEnabled: true,
            // glTF spec: when a clearcoat texture is present, factor defaults to 1.0.
            intensity: c.clearcoatFactor ?? (c.clearcoatTexture ? 1 : 0),
            roughness: c.clearcoatRoughnessFactor ?? (c.clearcoatRoughnessTexture ? 1 : 0),
            texture: ccTex?.ccTexture,
            roughnessTexture: ccTex?.ccRoughnessTexture,
            bumpTexture: ccTex?.ccNormalTexture,
            bumpTextureScale: c.clearcoatNormalTexture?.scale ?? 1,
            // glTF KHR_materials_clearcoat: F0 is not remapped across the CC interface
            // (BJS pbrMaterialLoadingAdapter.configureCoat sets remapF0OnInterfaceChange=false).
            useF0Remap: false,
        };
    }
    const s = m.sheen;
    if (s) {
        r.sheen = {
            isEnabled: true,
            color: s.sheenColorFactor ?? [0, 0, 0],
            roughness: s.sheenRoughnessFactor ?? 0,
            intensity: 1,
            texture: shTex?.sheenTexture,
            albedoScaling: true,
        };
    }
    const a = m.anisotropy;
    if (a) {
        const rot = a.anisotropyRotation ?? 0;
        r.anisotropy = { isEnabled: true, intensity: a.anisotropyStrength ?? 0, direction: [Math.cos(rot), Math.sin(rot)] };
    }
    return r;
}
