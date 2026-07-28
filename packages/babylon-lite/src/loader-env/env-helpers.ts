import type { EnvironmentTextures } from "./load-env.js";
import { polynomialToPreScaledHarmonics } from "./load-env.js";
import type { EngineContext } from "../engine/engine.js";
import { getBilinearSampler, getTrilinearSampler } from "../resource/samplers.js";

/** Fetch and decode the BRDF lookup texture with URL-specific diagnostics. */
export async function loadBrdfImage(url: string): Promise<ImageBitmap> {
    const response = await fetch(url);
    // SPA dev servers answer a missing asset with a 200 HTML fallback, so a bare
    // `createImageBitmap` fails as an opaque `InvalidStateError` naming nothing.
    const blob = await response.blob();
    if (!response.ok || blob.type.includes("html")) {
        throw new Error(`BRDF LUT '${url}' is not an image (${response.status} ${blob.type}).`);
    }
    return createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
}

/** Assemble the EnvironmentTextures object from pre-computed components */
export function assembleEnvironmentTextures(
    specularCube: GPUTexture,
    brdfLut: GPUTexture,
    irradianceSH: Float32Array,
    lodGenerationScale: number,
    engine: EngineContext
): EnvironmentTextures {
    return {
        specularCube,
        specularCubeView: specularCube.createView({ dimension: "cube" }),
        brdfLut,
        brdfLutView: brdfLut.createView(),
        cubeSampler: getTrilinearSampler(engine),
        brdfSampler: getBilinearSampler(engine),
        irradianceSH,
        sphericalHarmonics: polynomialToPreScaledHarmonics(irradianceSH),
        lodGenerationScale,
    };
}
