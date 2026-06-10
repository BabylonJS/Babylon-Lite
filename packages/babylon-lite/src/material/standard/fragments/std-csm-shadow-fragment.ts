/**
 * Standard CSM Shadow Fragment — Per-Light Cascaded Shadow Support
 *
 * Thin wrapper around the shared csm-shadow-fragment-core for Standard
 * materials. Only bundled when a scene uses a CSM-shadow-receiving Standard mesh.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import { createCsmShadowFragment } from "../../../shader/fragments/csm-shadow-fragment-core.js";

export type { CsmShadowLightSlot } from "../../../shader/fragments/csm-shadow-fragment-core.js";
import type { CsmShadowLightSlot } from "../../../shader/fragments/csm-shadow-fragment-core.js";

/**
 * Create a per-light CSM shadow fragment for Standard materials.
 * The shadow factor for each light is stored in `shadowFactors[lightIndex]`.
 */
export function createStdCsmShadowFragment(shadowLights: CsmShadowLightSlot[]): ShaderFragment {
    return createCsmShadowFragment("std-csm-shadow", shadowLights);
}
