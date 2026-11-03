/** PBR material view helper with no color output.
 *
 * This module is separate from pbr-material.ts so scenes that only create/use
 * ordinary PBR materials do not retain the helper.
 */

import { createMaterialView } from "../material-view.js";
import type { MaterialView } from "../material.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import { PBR_HAS_ALPHA_BLEND, PBR_HAS_NORMAL_MAP, PBR_HAS_SPEC_GLOSS, PBR2_HAS_REFRACTION, PBR2_NO_COLOR_OUTPUT } from "./pbr-flags.js";

/** Create a no-color view over a PBR source material.
 *  The view references the source; material state is never copied. It drops the normal-map and spec-gloss features,
 *  which only shade: the view then needs none of their lazily loaded WGSL, so a group built before the source gained
 *  one of them still composes a view whose bindings match its shader. It also drops refraction: a depth pass has no
 *  scene-colour grab to bind, and a view that kept the bit would wait for one at draw time. */
export function createPbrNoColorMaterialView(source: PbrMaterialProps): MaterialView {
    const features = source._renderFeatures ?? { features: 0, features2: 0 };
    return createMaterialView(source, {
        features: features.features & ~(PBR_HAS_ALPHA_BLEND | PBR_HAS_NORMAL_MAP | PBR_HAS_SPEC_GLOSS),
        features2: ((features.features2 ?? 0) & ~PBR2_HAS_REFRACTION) | PBR2_NO_COLOR_OUTPUT,
    });
}
