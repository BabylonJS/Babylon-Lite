import type { EngineContextInternal } from "../engine/engine.js";
import { getOrCreateSampler } from "./gpu-pool.js";

const _trilinearAnisotropicDesc: GPUSamplerDescriptor = {
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "repeat",
    addressModeW: "repeat",
    maxAnisotropy: 4,
};

export function getTrilinearAnisotropicSampler(engine: EngineContextInternal): GPUSampler {
    return getOrCreateSampler(engine, _trilinearAnisotropicDesc);
}
