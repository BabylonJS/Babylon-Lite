/** Standard shadow-depth material view helper.
 *
 * Kept outside standard-material.ts so ordinary Standard scenes do not retain
 * the helper.
 */

import { createMaterialView } from "../material-view.js";
import type { MaterialView } from "../material.js";
import { GENERATE_DEPTH_FOR_SHADOWS } from "./standard-flags.js";
import type { StandardMaterialProps } from "./standard-material.js";

/** Create a shadow-depth view over a Standard source material.
 *  The view references the source; material state is never copied. */
export function createStandardShadowDepthMaterialView(source: StandardMaterialProps): MaterialView {
    const features = source._renderFeatures ?? { features: 0 };
    return createMaterialView(source, { features: features.features | GENERATE_DEPTH_FOR_SHADOWS });
}
