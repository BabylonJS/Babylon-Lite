/**
 * Mixed Shadow Receiver — CSM together with ESM/PCF lights
 *
 * Composes the cascaded (CSM) receiver with the ESM/PCF receiver for a scene
 * that has both. Only loaded by such scenes, so CSM-only and ESM/PCF-only
 * bundles never carry it.
 */

import type { BindingDecl, ShaderFragment } from "../fragment-types.js";
import { wgsl, type WgslSource } from "../wgsl.js";
import { loadShadowFragmentFactory, type PreparedShadowFragmentFactory } from "./shadow-fragment-builder.js";
import type { ShadowLightSlot } from "./shadow-algorithms.js";

/**
 * @internal Prepare a receiver factory for a scene mixing CSM with ESM/PCF lights.
 *
 * `createCsm` builds the family's CSM receiver from the full slot list, and `adapt` maps the
 * ESM/PCF receiver onto the family's slots (PBR moves `AD` to `AS`).
 */
export async function loadMixedShadowFragmentFactory(
    shadowLights: readonly ShadowLightSlot[],
    createCsm: (slots: ShadowLightSlot[]) => ShaderFragment,
    adapt: (fragment: ShaderFragment) => ShaderFragment = (fragment) => fragment
): Promise<PreparedShadowFragmentFactory> {
    const isFallback = (slot: ShadowLightSlot) => slot.shadowType !== "csm";
    const createFallback = await loadShadowFragmentFactory(shadowLights.filter(isFallback));
    return (id, slots) => mergeShadowFragments(id, slots, createCsm(slots), adapt(createFallback(id, slots.filter(isFallback))));
}

/**
 * Both receivers write `shadowFactors[lightIndex]` and suffix every name with `_<lightIndex>`, so their code
 * composes as is. Bindings are put back in light-slot order, the order `createMaterialShadowBindings` binds
 * the shadow generators in.
 */
function mergeShadowFragments(id: string, shadowLights: readonly ShadowLightSlot[], csm: ShaderFragment, fallback: ShaderFragment): ShaderFragment {
    const bindings: BindingDecl[] = [];
    for (const slot of shadowLights) {
        const source = slot.shadowType === "csm" ? csm : fallback;
        const suffix = `_${slot.lightIndex}`;
        for (const binding of source._bindings ?? []) {
            if (binding._name.endsWith(suffix)) {
                bindings.push(binding);
            }
        }
    }

    return {
        _id: id,
        _varyings: [...(csm._varyings ?? []), ...(fallback._varyings ?? [])],
        _bindings: bindings,
        _helperFunctions: joinWgsl(csm._helperFunctions, fallback._helperFunctions),
        _vertexHelperFunctions: joinWgsl(csm._vertexHelperFunctions, fallback._vertexHelperFunctions),
        _vertexSlots: mergeSlots(csm._vertexSlots, fallback._vertexSlots),
        _fragmentSlots: mergeSlots(csm._fragmentSlots, fallback._fragmentSlots),
    };
}

function joinWgsl(a: WgslSource | undefined, b: WgslSource | undefined): WgslSource | undefined {
    return a && b ? wgsl`${a}\n${b}` : (a ?? b);
}

function mergeSlots<K extends string>(a: Partial<Record<K, WgslSource>> | undefined, b: Partial<Record<K, WgslSource>> | undefined): Partial<Record<K, WgslSource>> {
    const merged: Partial<Record<K, WgslSource>> = { ...a };
    for (const [slot, code] of Object.entries(b ?? {}) as [K, WgslSource | undefined][]) {
        merged[slot] = joinWgsl(merged[slot], code);
    }
    return merged;
}
