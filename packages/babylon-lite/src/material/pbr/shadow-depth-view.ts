/** PBR shadow-depth material view helper.
 *
 * This module is separate from pbr-material.ts so scenes that only create/use
 * ordinary PBR materials do not retain the helper.
 */

import { createMaterialView } from "../material-view.js";
import type { MaterialView } from "../material.js";
import { _computePbrMaterialFeatures, type PbrMaterialProps } from "./pbr-material.js";
import { PBR_HAS_ALPHA_BLEND, PBR2_GENERATE_DEPTH_FOR_SHADOWS } from "./pbr-flags.js";

/** Create a shadow-depth view over a PBR source material.
 *  The view references the source; material state is never copied. */
export function createPbrShadowDepthMaterialView(source: PbrMaterialProps): MaterialView {
    const features = source._renderFeatures ?? (source._renderFeatures = _computePbrMaterialFeatures(source));
    return createMaterialView(source, { features: features.features & ~PBR_HAS_ALPHA_BLEND, features2: (features.features2 ?? 0) | PBR2_GENERATE_DEPTH_FOR_SHADOWS });
}
