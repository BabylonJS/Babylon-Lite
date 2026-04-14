/**
 * Standard Shadow Fragment — Per-Light Shadow Support
 *
 * Thin wrapper around the shared shadow-fragment-core for Standard materials.
 * Only bundled when a scene uses shadow-receiving Standard meshes.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import { createShadowFragment } from "../../../shader/fragments/shadow-fragment-core.js";

export type { ShadowLightSlot } from "../../../shader/fragments/shadow-fragment-core.js";
import type { ShadowLightSlot } from "../../../shader/fragments/shadow-fragment-core.js";

/**
 * Create a per-light shadow fragment for Standard materials.
 * Each shadow-casting light gets its own varying, bindings, and sampling code.
 * The shadow factor for each light is stored in shadowFactors[lightIndex].
 */
export function createStdShadowFragment(shadowLights: ShadowLightSlot[]): ShaderFragment {
    return createShadowFragment("std-shadow", shadowLights);
}
