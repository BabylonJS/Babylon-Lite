import type { EngineContext } from "../engine/engine.js";
import { _createComputeBindingDecl, _installComputeBindingResolver, type ComputeBindingDecl } from "./compute-binding.js";
import type { ComputeSampler, ComputeSamplerType } from "./compute-sampler-resource.js";

const SAMPLER_KIND = 4;

/** Options for a compute sampler declaration. */
export interface ComputeSamplerBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly type?: ComputeSamplerType;
}

function resolveSampler(engine: EngineContext, decl: ComputeBindingDecl, input: unknown) {
    const sampler = input as ComputeSampler;
    const expected = decl._data as ComputeSamplerType;
    if (!sampler || sampler._engine !== engine || !sampler._sampler) {
        throw new Error(`ComputeBindingSet: sampler resource for "${decl.name}" is invalid or belongs to a different engine.`);
    }
    const compatible = sampler.type === expected || (expected === "filtering" && sampler.type === "non-filtering");
    if (!compatible) {
        throw new Error(`ComputeBindingSet: sampler "${decl.name}" has type ${sampler.type}, expected ${expected}.`);
    }
    return { _state: sampler };
}

function getSampler(engine: EngineContext, state: unknown): GPUBindingResource {
    const sampler = state as ComputeSampler;
    if (sampler._engine !== engine) {
        throw new Error("ComputeBindingSet contains an invalid sampler resource.");
    }
    return sampler._sampler;
}

/** Declare a sampler binding and opt into sampler support. */
export function computeSamplerBinding(name: string, options: ComputeSamplerBindingOptions): ComputeBindingDecl {
    _installComputeBindingResolver(SAMPLER_KIND, resolveSampler, getSampler);
    const type = options.type ?? "filtering";
    return _createComputeBindingDecl(name, options.group, options.binding, SAMPLER_KIND, { sampler: { type } }, type);
}
