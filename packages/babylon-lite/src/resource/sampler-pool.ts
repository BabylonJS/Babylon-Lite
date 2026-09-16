import type { EngineContext } from "../engine/engine.js";
import { getOrCreateSampler as getPooledSampler } from "./texture-sampler-pool.js";

export { clearSamplerCache } from "./texture-sampler-pool.js";

/** Get or create a deduplicated sampler. Same pooled config returns the same sampler. */
export function getOrCreateSampler(engine: EngineContext, descriptor: GPUSamplerDescriptor = {}): GPUSampler {
    const compare = descriptor.compare;
    const minLod = descriptor.lodMinClamp ?? 0;
    const maxLod = descriptor.lodMaxClamp ?? 32;
    const extraKey = compare !== undefined || minLod !== 0 || maxLod !== 32 ? `${compare ?? ""}:${minLod}:${maxLod}` : "";
    return getPooledSampler(engine, descriptor, extraKey);
}
