import type { StandardMaterialProps } from "./standard-material.js";
import { DIFFUSE_USES_UV2, DISABLE_LIGHTING, DOUBLE_SIDED, HAS_DIFFUSE_TEXTURE, MATERIAL_ALPHA_BLEND, _getStdExts } from "./standard-flags.js";

/** @internal Compute material-only bits; registered extensions own optional feature detection. */
export function _computeStandardMaterialFeatures(material: StandardMaterialProps): number {
    let features = 0;
    if (material.diffuseTexture) {
        features |= HAS_DIFFUSE_TEXTURE;
        if (material.diffuseCoordIndex === 1) {
            features |= DIFFUSE_USES_UV2;
        }
    }
    if (!material.backFaceCulling) {
        features |= DOUBLE_SIDED;
    }
    if (material.disableLighting) {
        features |= DISABLE_LIGHTING;
    }
    if (material.alpha < 1) {
        features |= MATERIAL_ALPHA_BLEND;
    }
    for (const extension of _getStdExts().values()) {
        if (extension._detect) {
            features |= extension._detect(material);
        }
    }
    return features;
}
