/**
 * Render-to-texture helper — eager allocation of a render target's GPU
 * textures so the color attachment, or depth attachment for depth-only targets,
 * can be exposed as a sampled texture BEFORE the frame graph is built.
 */

import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import { getBilinearSampler, getNearestSampler } from "../resource/samplers.js";
import type { RenderTarget, RenderTargetDescriptor } from "../engine/render-target.js";
import { createRenderTarget, buildRenderTarget } from "../engine/render-target.js";
import type { Texture2D } from "./texture-2d.js";

/** Eagerly allocate a render target's GPU textures and return a sampled-texture
 *  view of the color attachment, or the depth attachment for depth-only targets.
 *  Marks the RT so `buildRenderTarget` won't realloc.
 *
 *  The descriptor's size MUST be fixed (not `"canvas"`) because the canvas size
 *  may change before the frame graph builds, which would invalidate the eagerly-
 *  created texture handle that downstream bind groups have already captured. */
export function createRenderTargetTexture(engine: EngineContext, descriptor: RenderTargetDescriptor): { rt: RenderTarget; texture: Texture2D } {
    if (descriptor.size === "canvas") {
        throw new Error("createRenderTargetTexture: descriptor.size must be a fixed { width, height }, not 'canvas'.");
    }
    const eng = engine as EngineContextInternal;
    const rt = createRenderTarget(descriptor);
    buildRenderTarget(rt, eng);
    rt._eager = true;
    if (!rt._colorTexture || !rt._colorView) {
        if (!rt._depthTexture) {
            throw new Error("createRenderTargetTexture: render target has no color or depth texture (resolveToSwapchain with sampleCount=1?).");
        }
        const texture: Texture2D = {
            texture: rt._depthTexture,
            view: rt._depthTexture.createView({ aspect: "depth-only" }),
            sampler: getNearestSampler(eng),
            width: descriptor.size.width,
            height: descriptor.size.height,
            invertY: false,
            _sampleType: "depth",
        };
        return { rt, texture };
    }
    const texture: Texture2D = {
        texture: rt._colorTexture,
        view: rt._colorView,
        sampler: getBilinearSampler(eng),
        width: descriptor.size.width,
        height: descriptor.size.height,
        invertY: false,
    };
    return { rt, texture };
}
