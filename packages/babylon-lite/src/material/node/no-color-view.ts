/** NodeMaterial material view helper with no color output. */

import { createMaterialView } from "../material-view.js";
import type { MaterialView } from "../material.js";
import { NODE_NO_COLOR_OUTPUT } from "./node-flags.js";
import type { NodeMaterial } from "./node-material.js";

/** Create a no-color view over a NodeMaterial source. */
export function createNodeNoColorMaterialView(source: NodeMaterial): MaterialView {
    const features = source._renderFeatures ?? { features: 0 };
    return createMaterialView(source, { features: features.features | NODE_NO_COLOR_OUTPUT });
}
