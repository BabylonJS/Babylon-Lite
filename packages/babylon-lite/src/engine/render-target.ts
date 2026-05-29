/**
 * RenderTarget — describes and owns the GPU textures for a render pass.
 *
 * A RenderTarget is a pure-state description of color + depth/stencil
 * attachments. GPU textures are allocated during the frame graph build
 * phase (`buildRenderTarget`) and freed on dispose or rebuild.
 *
 * `createRenderTargetTexture` (texture/rtt.ts) eagerly allocates and marks
 * the target so subsequent build calls are no-ops, allowing the color or depth
 * view to be wired as a sampled texture before the frame graph is built.
 */

import type { EngineContextInternal } from "./engine.js";
import type { Texture2D } from "../texture/texture-2d.js";

/** Signature of a render target's attachment set — enough to key a GPURenderPipeline. */
export interface RenderTargetSignature {
    readonly _colorFormat?: GPUTextureFormat;
    readonly _depthStencilFormat?: GPUTextureFormat;
    /** Depth compare for this target. Defaults to reverse-Z `"greater-equal"`. Shadow-map targets use standard-Z `"less-equal"`. */
    readonly _depthCompare?: GPUCompareFunction;
    readonly _sampleCount: number;
    /** When true, the projection matrix's Y is flipped (offscreen RTT — see writePassSceneUBO).
     *  Pipelines must invert frontFace to keep back-face culling correct. */
    readonly _flipY?: boolean;
    /** Internal per-task refraction texture shared by transmissive material bindings. */
    readonly _transmissionTexture?: Texture2D | null;
}

/** Description of a render target — what to create, not the GPU objects themselves. */
export const REVERSE_DEPTH_COMPARE = "greater-equal" as GPUCompareFunction;

export interface RenderTargetDescriptor {
    label?: string;
    colorFormat?: GPUTextureFormat;
    depthStencilFormat?: GPUTextureFormat;
    /** Depth clear value. Defaults to reverse-Z far depth `0`. Shadow-map targets use standard-Z far depth `1`. */
    _depthClearValue?: number;
    /** Depth compare for pipelines targeting this RT. Defaults to reverse-Z `"greater-equal"`. */
    _depthCompare?: GPUCompareFunction;
    sampleCount: number;
    /** 'canvas' means match the canvas pixel size. Otherwise explicit pixels. */
    size: "canvas" | { width: number; height: number };
    /** If true, the color attachment resolves to the swapchain texture. The RT still
     *  owns the MSAA texture (when sampleCount > 1) and the depth texture; only the
     *  final color is the swapchain view, acquired per frame and patched in at execute
     *  time. With sampleCount === 1 the RT owns no color texture (the swap view is the
     *  color attachment directly). */
    resolveToSwapchain?: boolean;
    /** Override projection Y-flip. Defaults to true for offscreen targets and false for swapchain targets. */
    flipY?: boolean;
}

/** Stringified signature used to key pipelines against a render target's attachment set. */
export function targetSignatureKey(desc: RenderTargetSignature): string {
    return `${desc._colorFormat ?? "-"}|${desc._depthStencilFormat ?? "-"}|${desc._depthCompare ?? ""}|${desc._sampleCount}|${desc._flipY ? "y" : ""}`;
}

/** Allocated GPU state for a render target. */
export interface RenderTarget {
    readonly _descriptor: RenderTargetDescriptor;
    _colorTexture: GPUTexture | null;
    _colorView: GPUTextureView | null;
    _depthTexture: GPUTexture | null;
    _depthView: GPUTextureView | null;
    _width: number;
    _height: number;
    /** True when textures were allocated eagerly (before frame graph build) —
     *  `buildRenderTarget` becomes a no-op so existing GPUTexture handles
     *  (e.g. exposed as SampledTexture) stay valid. */
    _eager?: boolean;
}

/** Create a render target descriptor (GPU textures allocated by `buildRenderTarget`). */
export function createRenderTarget(descriptor: RenderTargetDescriptor): RenderTarget {
    return {
        _descriptor: descriptor,
        _colorTexture: null,
        _colorView: null,
        _depthTexture: null,
        _depthView: null,
        _width: 0,
        _height: 0,
    };
}

/** Allocate GPU textures for the render target. Idempotent for eager targets.
 *  For swapchain-resolved targets the color texture is only allocated when
 *  sampleCount > 1 (MSAA texture used as color attachment, swap view used as
 *  resolve target); with sampleCount === 1 the swap view is the color attachment
 *  directly so no color texture is owned. Depth is always owned by the RT. */
export function buildRenderTarget(rt: RenderTarget, engine: EngineContextInternal): void {
    if (rt._eager) {
        return;
    }
    disposeRenderTarget(rt);

    const desc = rt._descriptor;
    const { width, height } = resolveSize(desc, engine);
    rt._width = width;
    rt._height = height;

    const device = engine.device;
    const allocColor = !!desc.colorFormat && (!desc.resolveToSwapchain || desc.sampleCount > 1);

    if (allocColor) {
        rt._colorTexture = device.createTexture({
            label: desc.label,
            size: { width, height },
            format: desc.colorFormat!,
            sampleCount: desc.sampleCount,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        });
        rt._colorView = rt._colorTexture.createView();
    }

    if (desc.depthStencilFormat) {
        rt._depthTexture = device.createTexture({
            label: desc.label,
            size: { width, height },
            format: desc.depthStencilFormat,
            sampleCount: desc.sampleCount,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
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
