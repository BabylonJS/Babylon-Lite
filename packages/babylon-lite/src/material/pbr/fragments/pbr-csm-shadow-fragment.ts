/**
 * PBR CSM Shadow Fragment — Per-Light Cascaded Shadow Support
 *
 * Thin wrapper around the shared csm-shadow-fragment-core for PBR materials.
 * Only bundled when a scene uses a CSM-shadow-receiving PBR mesh.
 *
 * PBR exposes the fragment world position as `input.worldPos` (no view-space
 * varying), so the camera view-space z used for cascade selection is computed
 * inline from the scene view matrix, and the per-light shadow code is emitted
 * into slot `AS` (the PBR shadow slot) rather than `AD`.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import { createCsmShadowFragment } from "../../../shader/fragments/csm-shadow-fragment-core.js";

export type { CsmShadowLightSlot } from "../../../shader/fragments/csm-shadow-fragment-core.js";
import type { CsmShadowLightSlot } from "../../../shader/fragments/csm-shadow-fragment-core.js";

/**
 * Create a per-light CSM shadow fragment for PBR materials.
 * The shadow factor for each light is stored in `shadowFactors[lightIndex]`.
 */
export function createPbrCsmShadowFragment(shadowLights: CsmShadowLightSlot[]): ShaderFragment {
    return createCsmShadowFragment("pbr-csm-shadow", shadowLights, {
        worldPosExpr: "input.worldPos",
        viewZExpr: "(scene.view * vec4<f32>(input.worldPos, 1.0)).z",
        outputSlot: "AS",
    });
}
