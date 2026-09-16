import type { EngineContext } from "../engine/engine.js";
import type { ShadowGenerator } from "./shadow-generator.js";

/** @internal Scene-local shadow bindings, keyed by a material variant's group-2 layout. */
export type MaterialShadowBindings = (layout: GPUBindGroupLayout) => GPUBindGroup;

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
