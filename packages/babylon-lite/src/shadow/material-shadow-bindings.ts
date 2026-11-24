import type { EngineContext } from "../engine/engine.js";
import type { ShadowGenerator } from "./shadow-generator.js";
import type { ShadowLightSlot } from "../shader/fragments/shadow-fragment-core.js";

/** @internal Scene-local shadow bindings, keyed by a material variant's group-2 layout. */
export type MaterialShadowBindings = (layout: GPUBindGroupLayout) => GPUBindGroup;

/** @internal Variant-key token for a scene's ordered shadow slots: materials whose group-2 layouts differ must not share one. */
export function shadowVariantKey(lights: readonly ShadowLightSlot[]): string {
    return lights.map((sl) => `${sl.lightIndex}${sl.shadowType[0]}`).join(",");
}

/** @internal Loaded with receiver fragments, never by ordinary material builders. */
export function createMaterialShadowBindings(engine: EngineContext, lights: readonly { readonly gen: ShadowGenerator }[]): MaterialShadowBindings {
    const cache = new WeakMap<GPUBindGroupLayout, GPUBindGroup>();
    return (layout) => {
        let binding = cache.get(layout);
        if (!binding) {
            const entries: GPUBindGroupEntry[] = [];
            for (const { gen } of lights) {
                entries.push(
                    { binding: entries.length, resource: gen._depthTexture.createView() },
                    { binding: entries.length + 1, resource: gen._depthSampler },
                    { binding: entries.length + 2, resource: { buffer: gen._shadowUBO } }
                );
            }
            binding = engine._device.createBindGroup({ layout, entries });
            cache.set(layout, binding);
        }
        return binding;
    };
}
