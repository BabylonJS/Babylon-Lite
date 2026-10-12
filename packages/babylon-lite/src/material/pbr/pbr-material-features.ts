import type { PbrMaterialProps } from "./pbr-material.js";
import {
    _getPbrExts,
    PBR2_HAS_BASE_COLOR_FACTOR,
    PBR2_HAS_UV2,
    PBR_HAS_ALPHA_BLEND,
    PBR_HAS_DOUBLE_SIDED,
    PBR_HAS_EMISSIVE,
    PBR_HAS_NORMAL_MAP,
    PBR_HAS_OCCLUSION,
    PBR_HAS_SPECULAR_AA,
    PBR_HAS_SPEC_GLOSS,
} from "./pbr-flags.js";

/** @internal Compute PBR material-only feature bits. Mesh/pass bits are added per renderable. */
export function _computePbrMaterialFeatures(mat: PbrMaterialProps): { features: number; features2: number } {
    let features =
        (mat.emissiveTexture ? PBR_HAS_EMISSIVE : 0) |
        (mat.normalTexture ? PBR_HAS_NORMAL_MAP : 0) |
        (mat.alphaBlend === true || ((mat._alphaCutOff ?? 0) <= 0 && mat.alpha! < 1) ? PBR_HAS_ALPHA_BLEND : 0) |
        (mat.specGlossTexture ? PBR_HAS_SPEC_GLOSS : 0) |
        (mat.doubleSided ? PBR_HAS_DOUBLE_SIDED : 0);
    if ((mat.occlusionStrength ?? 1.0) > 0) {
        features |= PBR_HAS_OCCLUSION;
    }
    if (mat.enableSpecularAA) {
        features |= PBR_HAS_SPECULAR_AA;
    }

    let features2 = 0;
    for (const ext of _getPbrExts().values()) {
        if (ext.detect) {
            const d = ext.detect(mat);
            features |= d.f;
            features2 |= d.f2;
        }
    }
    // gltf-pbr-builder-ext precomputes every texture channel that requires UV2,
    // including occlusion in bit 32; any set bit enables the shared UV2 attribute.
    if ((mat as { _uv2Mask?: number })._uv2Mask) {
        features2 |= PBR2_HAS_UV2;
    }
    if (mat.baseColorFactor) {
        features2 |= PBR2_HAS_BASE_COLOR_FACTOR;
    }
    return { features, features2 };
}
