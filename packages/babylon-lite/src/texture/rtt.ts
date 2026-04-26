/**
 * Render-to-texture helpers — eager allocation of a render target's GPU textures
 * so the color attachment can be exposed as a `SampledTexture` (e.g. used as a
 * material's diffuse texture) BEFORE the frame graph is built.
 */

import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import type { SampledTexture } from "../texture/texture-2d.js";
import { getBilinearSampler } from "../resource/gpu-pool.js";
import type { RenderTarget, RenderTargetDescriptor } from "../engine/render-target.js";
import { createRenderTarget, buildRenderTarget } from "../engine/render-target.js";

/** Eagerly allocate a render target's GPU textures and return a `SampledTexture`
 *  view of the color attachment. Marks the RT so `buildFrameGraph` won't realloc.
 *
 *  Use this when an RTT pass's color output must be referenced (e.g. as a material
 *  texture) at scene authoring time, before `buildFrameGraph` runs. The descriptor's
 *  size MUST be fixed (not `"canvas"`) because the canvas size may change before
 *  buildFrameGraph runs. */
export function createRenderTargetTexture(engine: EngineContext, descriptor: RenderTargetDescriptor): { rt: RenderTarget; texture: SampledTexture } {
    if (descriptor.size === "canvas") {
        throw new Error("createRenderTargetTexture: descriptor.size must be a fixed { width, height }, not 'canvas'.");
    }
    const eng = engine as EngineContextInternal;
    const rt = createRenderTarget(descriptor);
    buildRenderTarget(rt, eng);
    rt._eager = true;
    if (!rt._colorTexture || !rt._colorView) {
        throw new Error("createRenderTargetTexture: render target has no color texture (resolveToSwapchain with sampleCount=1?).");
    }
    const texture: SampledTexture = {
        texture: rt._colorTexture,
        view: rt._colorView,
        sampler: getBilinearSampler(eng),
    };
    return { rt, texture };
}
