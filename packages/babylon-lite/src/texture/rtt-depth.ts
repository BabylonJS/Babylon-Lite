import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { getNearestSampler } from "../resource/samplers.js";
import type { Texture2D } from "./texture-2d.js";

/** Opt in to a sampled depth facade by passing this helper to an RTT factory.
 *  The target keeps attachment ownership; materials acquire their own sampling references. */
export function withSampledDepthTexture(engine: EngineContext, target: RenderTarget): Texture2D {
    if (!target._depthTexture) {
        throw new Error("withSampledDepthTexture requires a render target with a depth attachment.");
    }
    return {
        texture: target._depthTexture,
        view: target._depthTexture.createView({ aspect: "depth-only" }),
        sampler: getNearestSampler(engine),
        width: target._width,
        height: target._height,
        invertY: false,
        _sampleType: "depth",
    };
}
