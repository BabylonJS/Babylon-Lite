/**
 * PBR Shadow Fragment — Per-Light Shadow Support
 *
 * Thin wrapper around the shared shadow-fragment-core for PBR materials.
 * Only bundled when a scene uses shadow-receiving PBR meshes.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import { createShadowFragment } from "../../../shader/fragments/shadow-fragment-core.js";
import type { ShadowLightSlot } from "../../../shader/fragments/shadow-fragment-core.js";

/** Type alias preserving the existing PBR-specific name. */
export type PbrShadowLightSlot = ShadowLightSlot;

/**
 * Create a per-light PBR shadow fragment.
 * Each shadow-casting light gets its own varying, bindings, and sampling code.
 * The shadow factor for each light is stored in shadowFactors[lightIndex].
 */
export function createPbrShadowFragment(shadowLights: PbrShadowLightSlot[] = [{ lightIndex: 0, shadowType: "esm" }]): ShaderFragment {
    const fragment = createShadowFragment("pbr-shadow", shadowLights);
    const shadowCode = fragment._fragmentSlots?.AD;
    return {
        ...fragment,
        _fragmentSlots: shadowCode ? { AS: shadowCode } : undefined,
    };
}
