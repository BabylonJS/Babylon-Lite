/**
 * RenderTarget — describes and owns the GPU textures for a render pass.
 *
 * A RenderTarget is a pure-state description of color + depth/stencil
 * attachments. GPU textures are allocated during the frame graph build
 * phase and freed on dispose or rebuild.
 *
 * For the default swapchain target, the color resolve target is acquired
 * per-frame via context.getCurrentTexture().
 */

import type { EngineContextInternal } from "../engine/engine.js";

/** Description of a render target — what to create, not the GPU objects themselves. */
export interface RenderTargetDescriptor {
    label?: string;
    colorFormat: GPUTextureFormat;
    depthStencilFormat?: GPUTextureFormat;
    sampleCount: number;
    /** 'canvas' means match the canvas pixel size. Otherwise explicit pixels. */
    size: "canvas" | { width: number; height: number };
    /** If true, the color attachment resolves to the swapchain texture. */
    resolveToSwapchain?: boolean;
}

/** Stringified signature used to key pipelines against a render target's attachment set. */
export function targetSignatureKey(desc: { colorFormat: GPUTextureFormat; depthStencilFormat?: GPUTextureFormat; sampleCount: number; flipY?: boolean }): string {
    return `${desc.colorFormat}|${desc.depthStencilFormat ?? "-"}|${desc.sampleCount}|${desc.flipY ? "flipY" : ""}`;
}

/** Allocated GPU state for a render target. Created during frame graph build. */
export interface RenderTarget {
    readonly descriptor: RenderTargetDescriptor;
    _colorTexture: GPUTexture | null;
    _colorView: GPUTextureView | null;
    _depthTexture: GPUTexture | null;
    _depthView: GPUTextureView | null;
    _width: number;
    _height: number;
    /** True when textures were allocated eagerly (before frame graph build) — buildRenderTarget
     *  becomes a no-op so existing GPUTexture handles (e.g. exposed as SampledTexture) stay valid.
     *
     *  TODO: remove `_eager` once texture management is virtualized. The right fix is for the
     *  render target's color/depth handles to be created in `createRenderTarget` (constructor)
     *  as virtual texture references that user code can immediately wire as a material's
     *  diffuse texture. The actual GPUTexture is then allocated/reallocated inside the virtual
     *  handle by `buildRenderTarget` (including on resize), without invalidating the handle
     *  identity that downstream bind groups already captured. This eliminates the eager
     *  allocation special case entirely. */
    _eager?: boolean;
}

/** Create a render target (descriptor only — GPU textures are allocated by buildRenderTarget). */
export function createRenderTarget(descriptor: RenderTargetDescriptor): RenderTarget {
    return {
        descriptor,
        _colorTexture: null,
        _colorView: null,
        _depthTexture: null,
        _depthView: null,
        _width: 0,
        _height: 0,
    };
}

/** Allocate GPU textures for the render target. Called during frame graph build.
 *  Idempotent — if `_eager` is set (textures allocated by `createRenderTargetTexture`),
 *  this is a no-op so handles remain valid for already-created bind groups. */
export function buildRenderTarget(rt: RenderTarget, engine: EngineContextInternal): void {
    if (rt._eager) {
        return;
    }
    disposeRenderTarget(rt);

    const desc = rt.descriptor;
    const { width, height } = resolveSize(desc, engine);
    rt._width = width;
    rt._height = height;

    const device = engine.device;

    // When resolving to the swapchain at sampleCount=1, there's no MSAA resolve
    // step — the pass renders directly into the swapchain texture (acquired per
    // frame at execute time), so no offscreen color texture is needed.
    const needsColorTexture = !(desc.resolveToSwapchain && desc.sampleCount === 1);

    if (needsColorTexture) {
        rt._colorTexture = device.createTexture({
            label: desc.label ? `${desc.label}-color` : "rt-color",
            size: { width, height },
            format: desc.colorFormat,
            sampleCount: desc.sampleCount,
            // TEXTURE_BINDING is included unconditionally so the color attachment can be
            // sampled by downstream passes (RTT). Cost is negligible for offscreen RTs.
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        rt._colorView = rt._colorTexture.createView();
    }

    if (desc.depthStencilFormat) {
        rt._depthTexture = device.createTexture({
            label: desc.label ? `${desc.label}-depth` : "rt-depth",
            size: { width, height },
            format: desc.depthStencilFormat,
            sampleCount: desc.sampleCount,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        rt._depthView = rt._depthTexture.createView();
    }
}

/** Free GPU textures owned by the render target. */
export function disposeRenderTarget(rt: RenderTarget): void {
    if (rt._colorTexture) {
        rt._colorTexture.destroy();
        rt._colorTexture = null;
        rt._colorView = null;
    }
    if (rt._depthTexture) {
        rt._depthTexture.destroy();
        rt._depthTexture = null;
        rt._depthView = null;
    }
    rt._width = 0;
    rt._height = 0;
}

function resolveSize(desc: RenderTargetDescriptor, engine: EngineContextInternal): { width: number; height: number } {
    if (desc.size === "canvas") {
        return { width: engine.canvas.width, height: engine.canvas.height };
    }
    return desc.size;
}
