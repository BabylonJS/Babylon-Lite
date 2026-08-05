import type { EnvironmentTextures } from "./load-env.js";
import { polynomialToPreScaledHarmonics } from "./load-env.js";
import type { EngineContext } from "../engine/engine.js";
import { getBilinearSampler, getTrilinearSampler } from "../resource/samplers.js";

/** Fetch and decode the BRDF lookup texture with URL-specific diagnostics. */
export async function loadBrdfImage(url: string): Promise<ImageBitmap> {
    const response = await fetch(url);
    // A non-OK status is rejected without reading the body, so a 404 placeholder image cannot
    // silently stand in for the LUT and an SPA error page is never buffered just for diagnostics.
    if (response.ok) {
        try {
            // A bare `createImageBitmap` rejects as an opaque `InvalidStateError` naming nothing, so
            // every decode failure — SPA 200 HTML fallback, text/plain, corrupt PNG — funnels into
            // the diagnostic below.
            return await createImageBitmap(await response.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        } catch {
            // Fall through to the shared diagnostic.
        }
    }
    throw new Error(`BRDF LUT '${url}' is not an image (${response.status} ${response.headers.get("content-type") ?? ""}).`);
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
