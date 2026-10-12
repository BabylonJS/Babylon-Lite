/**
 * PBR Shadow Fragment — Per-Light Shadow Support
 *
 * Selects CSM or an asynchronously prepared fallback receiver for PBR
 * materials. Only bundled when a scene has shadow-receiving PBR meshes.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { PreparedShadowFragmentFactory } from "../../../shader/fragments/shadow-fragment-builder.js";
import type { ShadowLightSlot } from "../../../shader/fragments/shadow-fragment-core.js";
import { getCsmPbrReceiverFactory } from "../../../shadow/csm-receiver-registry.js";

export { createMaterialShadowBindings } from "../../../shadow/material-shadow-bindings.js";

/** Type alias preserving the existing PBR-specific name. */
export type PbrShadowLightSlot = ShadowLightSlot;

/** @internal Prepare a scene-local synchronous PBR receiver factory. */
export async function preparePbrShadowFragment(shadowLights: PbrShadowLightSlot[]): Promise<(slots: PbrShadowLightSlot[]) => ShaderFragment> {
    if (shadowLights.some((slot) => slot.shadowType === "csm")) {
        return createPbrShadowFragment;
    }
    const builder = await import("../../../shader/fragments/shadow-fragment-builder.js");
    const createFallback = await builder.loadShadowFragmentFactory(shadowLights);
    return (slots) => toPbrShadowFragment(createFallback("pbr-shadow", slots));
}

/**
 * Create a per-light PBR shadow fragment.
 * Each shadow-casting light gets its own varying, bindings, and sampling code.
 * The shadow factor for each light is stored in shadowFactors[lightIndex].
 *
 * If any slot is a cascaded-shadow (`"csm"`) light, the cascaded receiver factory
 * registered by the CSM generator is used (it already emits into slot `AS`).
 * Otherwise the prepared ESM/PCF factory is used and its `AD` slot is remapped to `AS`.
 */
export function createPbrShadowFragment(
    shadowLights: PbrShadowLightSlot[] = [{ lightIndex: 0, shadowType: "esm" }],
    createFallback?: PreparedShadowFragmentFactory
): ShaderFragment {
    const csmSlots = shadowLights.filter((sl) => sl.shadowType === "csm");
    if (csmSlots.length > 0) {
        return getCsmPbrReceiverFactory()!(csmSlots.map((s) => ({ lightIndex: s.lightIndex })));
    }
    if (!createFallback) {
        throw new Error("PBR shadow receiver algorithms were not prepared.");
    }
    return toPbrShadowFragment(createFallback("pbr-shadow", shadowLights));
}

function toPbrShadowFragment(fragment: ShaderFragment): ShaderFragment {
    const shadowCode = fragment._fragmentSlots?.AD;
    return {
        ...fragment,
        _fragmentSlots: shadowCode ? { AS: shadowCode } : undefined,
    };
}
