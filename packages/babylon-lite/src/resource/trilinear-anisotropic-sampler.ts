import type { EngineContext } from "../engine/engine.js";
import { getOrCreateSampler, type TextureSamplerDescriptor } from "./texture-sampler-pool.js";

const _trilinearAnisotropicDesc: TextureSamplerDescriptor = {
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "repeat",
    addressModeW: "repeat",
    maxAnisotropy: 4,
};

export function getTrilinearAnisotropicSampler(engine: EngineContext): GPUSampler {
    return getOrCreateSampler(engine, _trilinearAnisotropicDesc);
}
