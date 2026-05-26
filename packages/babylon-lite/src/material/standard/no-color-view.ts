/** Standard material view helper with no color output.
 *
 * Kept outside standard-material.ts so ordinary Standard scenes do not retain
 * the helper.
 */

import { createMaterialView } from "../material-view.js";
import type { MaterialView } from "../material.js";
import { NO_COLOR_OUTPUT } from "./standard-flags.js";
import type { StandardMaterialProps } from "./standard-material.js";

/** Create a no-color view over a Standard source material.
 *  The view references the source; material state is never copied. */
export function createStandardNoColorMaterialView(source: StandardMaterialProps): MaterialView {
    const features = source._renderFeatures ?? { features: 0 };
    return createMaterialView(source, { features: features.features | NO_COLOR_OUTPUT });
}
