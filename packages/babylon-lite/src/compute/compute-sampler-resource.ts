import type { EngineContext } from "../engine/engine.js";

declare const computeSamplerBrand: unique symbol;

/** Sampler layout type used by compute binding validation. */
export type ComputeSamplerType = "filtering" | "non-filtering" | "comparison";

/** Opaque compute sampler with known device ownership and binding type. */
export interface ComputeSampler {
    readonly [computeSamplerBrand]: true;
    readonly type: ComputeSamplerType;
    /** @internal */
    readonly _engine: EngineContext;
    /** @internal */
    _sampler: GPUSampler;
}

/** @internal Classify the descriptor before allocating a GPU sampler. */
export function _inferComputeSamplerType(descriptor: GPUSamplerDescriptor = {}): ComputeSamplerType {
    return descriptor.compare
        ? "comparison"
        : descriptor.minFilter === "linear" || descriptor.magFilter === "linear" || descriptor.mipmapFilter === "linear"
          ? "filtering"
          : "non-filtering";
}

/** Create a compute sampler without entering the shared render sampler cache. */
export function createComputeSampler(engine: EngineContext, descriptor: GPUSamplerDescriptor = {}): ComputeSampler {
    return {
        type: _inferComputeSamplerType(descriptor),
        _engine: engine,
        _sampler: engine._device.createSampler(descriptor),
    } as unknown as ComputeSampler;
}
