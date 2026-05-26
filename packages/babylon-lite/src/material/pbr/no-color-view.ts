/** PBR material view helper with no color output.
 *
 * This module is separate from pbr-material.ts so scenes that only create/use
 * ordinary PBR materials do not retain the helper.
 */

import { createMaterialView } from "../material-view.js";
import type { MaterialView } from "../material.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import { PBR_HAS_ALPHA_BLEND, PBR2_NO_COLOR_OUTPUT } from "./pbr-flags.js";

/** Create a no-color view over a PBR source material.
 *  The view references the source; material state is never copied. */
export function createPbrNoColorMaterialView(source: PbrMaterialProps): MaterialView {
    const features = source._renderFeatures ?? { features: 0, features2: 0 };
    return createMaterialView(source, { features: features.features & ~PBR_HAS_ALPHA_BLEND, features2: (features.features2 ?? 0) | PBR2_NO_COLOR_OUTPUT });
}
