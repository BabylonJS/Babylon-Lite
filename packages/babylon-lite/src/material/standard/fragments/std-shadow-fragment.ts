/**
 * Standard Shadow Fragment — Per-Light Shadow Support
 *
 * Thin wrapper around the shared shadow-fragment-core for Standard materials.
 * Only bundled when a scene uses shadow-receiving Standard meshes.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import { createShadowFragment } from "../../../shader/fragments/shadow-fragment-core.js";
import { getCsmStdReceiverFactory } from "../../../shadow/csm-receiver-registry.js";

export type { ShadowLightSlot } from "../../../shader/fragments/shadow-fragment-core.js";
import type { ShadowLightSlot } from "../../../shader/fragments/shadow-fragment-core.js";

/**
 * Create a per-light shadow fragment for Standard materials.
 * Each shadow-casting light gets its own varying, bindings, and sampling code.
 * The shadow factor for each light is stored in shadowFactors[lightIndex].
 *
 * If any slot is a cascaded-shadow (`"csm"`) light, the cascaded receiver factory
 * registered by the CSM generator is used (v1: a scene mixing CSM with ESM/PCF
 * receivers on the same mesh is unsupported). Otherwise the plain ESM/PCF core is used.
 */
export function createStdShadowFragment(shadowLights: ShadowLightSlot[]): ShaderFragment {
    const csmSlots = shadowLights.filter((sl) => sl.shadowType === "csm");
    if (csmSlots.length > 0) {
        return getCsmStdReceiverFactory()!(csmSlots.map((s) => ({ lightIndex: s.lightIndex })));
    }
    return createShadowFragment("std-shadow", shadowLights);
}
