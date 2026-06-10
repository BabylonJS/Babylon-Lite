/** ShaderMaterial material view helper with no colour output (for shadow casting). */

import { createMaterialView } from "../material-view.js";
import type { MaterialView } from "../material.js";
import type { ShaderMaterial } from "./shader-material.js";

/**
 * Create a no-colour view over a ShaderMaterial source, used by the shadow caster pass.
 *
 * Unlike standard/PBR/node, a ShaderMaterial needs no feature flag to drop its colour output: the shader
 * pipeline already omits the fragment stage when the render target has no colour attachment (the depth-only
 * shadow map). The view exists purely so the caster gets its OWN renderable + system UBO (written with the
 * shadow camera's view-projection) instead of clobbering the source material's main-pass UBO.
 */
export function createShaderNoColorMaterialView(source: ShaderMaterial): MaterialView {
    return createMaterialView(source, { features: 0 });
}
