/**
 * Standard Shadow Fragment — Per-Light Shadow Support
 *
 * Selects CSM or an asynchronously prepared fallback receiver for Standard
 * materials. Only bundled when a scene has shadow-receiving Standard meshes.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { PreparedShadowFragmentFactory } from "../../../shader/fragments/shadow-fragment-builder.js";
import { getCsmStdReceiverFactory } from "../../../shadow/csm-receiver-registry.js";
import type { EngineContext } from "../../../engine/engine.js";
import type { ShadowGenerator } from "../../../shadow/shadow-generator.js";
import { createMaterialShadowBindings, type MaterialShadowBindings } from "../../../shadow/material-shadow-bindings.js";

export type { ShadowLightSlot } from "../../../shader/fragments/shadow-fragment-core.js";
import type { ShadowLightSlot } from "../../../shader/fragments/shadow-fragment-core.js";

/** @internal Scene-local receiver behavior supplied only after shadow support is loaded. */
export interface StandardShadowContext {
    /** @internal */
    readonly _key: string;
    /** @internal */
    readonly _fragment: () => ShaderFragment;
    /** @internal */
    readonly _bindings: MaterialShadowBindings;
}

/** @internal Capture and asynchronously prepare the scene's immutable shadow slots once. */
export async function createStandardShadowContext(engine: EngineContext, lights: readonly { shadowGenerator?: ShadowGenerator }[]): Promise<StandardShadowContext> {
    const slots: (ShadowLightSlot & { gen: ShadowGenerator })[] = [];
    for (let index = 0; index < lights.length; index++) {
        const gen = lights[index]!.shadowGenerator;
        if (gen) {
            slots.push({ lightIndex: index, shadowType: gen._shadowType, gen });
        }
    }
    let createFallback: PreparedShadowFragmentFactory | undefined;
    if (!slots.some((slot) => slot.shadowType === "csm")) {
        const builder = await import("../../../shader/fragments/shadow-fragment-builder.js");
        createFallback = await builder.loadShadowFragmentFactory(slots);
    }
    let fragment: ShaderFragment | undefined;
    return {
        _key: standardShadowVariantKey(slots),
        _fragment: () => (fragment ??= createFallback ? createFallback("std-shadow", slots) : createStdShadowFragment(slots)),
        _bindings: createMaterialShadowBindings(engine, slots),
    };
}

function standardShadowVariantKey(shadowLights: readonly ShadowLightSlot[]): string {
    return shadowLights.length === 0 ? "" : shadowLights.map((sl) => `${sl.lightIndex}${sl.shadowType === "pcf" ? "p" : "e"}`).join(",");
}

/**
 * Create a per-light shadow fragment for Standard materials.
 * Each shadow-casting light gets its own varying, bindings, and sampling code.
 * The shadow factor for each light is stored in shadowFactors[lightIndex].
 *
 * If any slot is a cascaded-shadow (`"csm"`) light, the cascaded receiver factory
 * registered by the CSM generator is used (v1: a scene mixing CSM with ESM/PCF
 * receivers on the same mesh is unsupported). Otherwise the prepared ESM/PCF factory is used.
 */
export function createStdShadowFragment(shadowLights: ShadowLightSlot[], createFallback?: PreparedShadowFragmentFactory): ShaderFragment {
    const csmSlots = shadowLights.filter((sl) => sl.shadowType === "csm");
    if (csmSlots.length > 0) {
        return getCsmStdReceiverFactory()!(csmSlots.map((s) => ({ lightIndex: s.lightIndex })));
    }
    if (!createFallback) {
        throw new Error("Standard shadow receiver algorithms were not prepared.");
    }
    return createFallback("std-shadow", shadowLights);
}
