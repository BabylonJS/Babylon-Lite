import type { EnvironmentTextures } from "./load-env.js";
import { polynomialToPreScaledHarmonics } from "./load-env.js";
import type { EngineContext } from "../engine/engine.js";
import { getBilinearSampler, getTrilinearSampler } from "../resource/samplers.js";

/** Create the standard sampler pair used by all environment loaders */
export function createEnvSamplers(engine: EngineContext): { cubeSampler: GPUSampler; brdfSampler: GPUSampler } {
    return {
        cubeSampler: getTrilinearSampler(engine),
        brdfSampler: getBilinearSampler(engine),
    };
}

/** Assemble the EnvironmentTextures object from pre-computed components */
export function assembleEnvironmentTextures(
    specularCube: GPUTexture,
    brdfLut: GPUTexture,
    irradianceSH: Float32Array,
    lodGenerationScale: number,
    engine: EngineContext
): EnvironmentTextures {
    const { cubeSampler, brdfSampler } = createEnvSamplers(engine);
    return {
        specularCube,
        specularCubeView: specularCube.createView({ dimension: "cube" }),
        brdfLut,
        brdfLutView: brdfLut.createView(),
        cubeSampler,
        brdfSampler,
        irradianceSH,
        sphericalHarmonics: polynomialToPreScaledHarmonics(irradianceSH),
        lodGenerationScale,
    };
}
