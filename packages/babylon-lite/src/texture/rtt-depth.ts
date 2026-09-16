import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { getNearestSampler } from "../resource/samplers.js";
import type { Texture2D } from "./texture-2d.js";

/** Opt in to a sampled depth facade by passing this helper to an RTT factory.
 *  Requires a single-sample depth attachment. The target keeps attachment ownership;
 *  materials acquire their own sampling references. */
export function withSampledDepthTexture(engine: EngineContext, target: RenderTarget): Texture2D {
    const depth = target._depthTexture;
    if (depth?.sampleCount !== 1) {
        throw new Error("withSampledDepthTexture requires a single-sample depth attachment.");
    }
    return {
        texture: depth,
        view: depth.createView({ aspect: "depth-only" }),
        sampler: getNearestSampler(engine),
        width: target._width,
        height: target._height,
        invertY: false,
        _sampleType: "depth",
    };
}
