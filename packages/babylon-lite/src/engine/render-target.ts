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

import { TU } from "./gpu-flags.js";
import type { EngineContext } from "./engine.js";
import type { Texture2D } from "../texture/texture-2d.js";

/** Signature of a render target's attachment set — enough to key a GPURenderPipeline. */
export interface RenderTargetSignature {
    /** @internal */
    readonly _colorFormat?: GPUTextureFormat;
    /** @internal */
    readonly _depthStencilFormat?: GPUTextureFormat;
    /** @internal Depth compare for this target. Defaults to reverse-Z `"greater-equal"`. Shadow-map targets use standard-Z `"less-equal"`. */
    readonly _depthCompare?: GPUCompareFunction;
    /** @internal */
    readonly _sampleCount: number;
    /** @internal Internal per-task refraction texture shared by transmissive material bindings. */
    readonly _transmissionTexture?: Texture2D | null;
}

/** Description of a render target — what to create, not the GPU objects themselves. */
export const REVERSE_DEPTH_COMPARE = "greater-equal" as GPUCompareFunction;

/** Describes a render target — what attachments to create, not the GPU objects
 *  themselves. GPU textures are allocated later by `buildRenderTarget`. */
export interface RenderTargetDescriptor {
    /** Debug label applied to the allocated GPU color/depth textures. */
    lbl?: string;
    /** Color attachment texture format (e.g. `"bgra8unorm"`, `"rgba16float"`). Omit for a depth-only target. */
    format?: GPUTextureFormat;
    /** Depth/stencil attachment format (e.g. `"depth24plus-stencil8"`). Omit for a color-only target (e.g. the swapchain). */
    dFormat?: GPUTextureFormat;
    /** @internal Depth clear value. Defaults to reverse-Z far depth `0`. Shadow-map targets use standard-Z far depth `1`. */
    _depthClearValue?: number;
    /** @internal Depth compare for pipelines targeting this RT. Defaults to reverse-Z `"greater-equal"`. */
    _depthCompare?: GPUCompareFunction;
    /** MSAA sample count: `1` = single-sample (no multisampling), `4` = 4x MSAA. */
    samples: number;
    /** 'canvas' means match the canvas pixel size. Otherwise explicit pixels. */
    size: "canvas" | { width: number; height: number };
}

/** Stringified signature used to key pipelines against a render target's attachment set. */
export function targetSignatureKey(desc: RenderTargetSignature): string {
    return `${desc._colorFormat ?? "-"}|${desc._depthStencilFormat ?? "-"}|${desc._depthCompare ?? ""}|${desc._sampleCount}`;
}

/** Allocated GPU state for a render target. */
export interface RenderTarget {
    /** @internal */
    readonly _descriptor: RenderTargetDescriptor;
    /** @internal */
    _colorTexture: GPUTexture | null;
    /** @internal */
    _colorView: GPUTextureView | null;
    /** @internal */
    _depthTexture: GPUTexture | null;
    /** @internal */
    _depthView: GPUTextureView | null;
    /** @internal */
    _width: number;
    /** @internal */
    _height: number;
    /** True when textures were allocated eagerly (before frame graph build) —
     *  `buildRenderTarget` becomes a no-op so existing GPUTexture handles
     *  (e.g. exposed as SampledTexture) stay valid. */
    /** @internal */
    _eager?: boolean;
    /** @internal When false, `disposeRenderTarget` will NOT destroy `_depthTexture` — the depth
     *  attachment is BORROWED (owned by something else, e.g. a ShadowGenerator's shared shadow map)
     *  and must outlive this render target. Defaults to owning (destroys on dispose). */
    _ownsDepthTexture?: boolean;
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

/** Allocate GPU textures for the render target. Idempotent for eager targets
 *  (`_eager` — e.g. `createRenderTargetTexture` outputs and the engine-owned
 *  `scRT`, whose color texture the engine refreshes per frame). A
 *  color texture is allocated whenever the descriptor has a `format`; depth
 *  is allocated whenever it has a `depthStencilFormat`. */
export function buildRenderTarget(rt: RenderTarget, engine: EngineContext): void {
    if (rt._eager) {
        return;
    }
    disposeRenderTarget(rt);

    const desc = rt._descriptor;
    const { width, height } = resolveSize(desc, engine);
    rt._width = width;
    rt._height = height;

    const device = engine._device;
    const allocColor = !!desc.format;

    if (allocColor) {
        rt._colorTexture = device.createTexture({
            label: desc.lbl,
            size: { width, height },
            format: desc.format!,
            sampleCount: desc.samples,
            usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING | TU.COPY_SRC,
        });
        rt._colorView = rt._colorTexture.createView();
    }

    if (desc.dFormat) {
        rt._depthTexture = device.createTexture({
            label: desc.lbl,
            size: { width, height },
            format: desc.dFormat,
            sampleCount: desc.samples,
            usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING,
        });
        rt._depthView = rt._depthTexture.createView();
    }
}

/** Free GPU textures owned by the render target. No-op for `null`/`undefined` and for
 *  `_eager` targets — the latter (e.g. the engine `scRT` and `GeometryRendererTask`
 *  depth outputs) are owned externally, so callers can pass them unconditionally. */
export function disposeRenderTarget(rt: RenderTarget | null | undefined): void {
    if (!rt || rt._eager) {
        return;
    }
    if (rt._colorTexture) {
        rt._colorTexture.destroy();
        rt._colorTexture = null;
        rt._colorView = null;
    }
    if (rt._depthTexture) {
        // Only destroy depth we own — borrowed depth (e.g. a ShadowGenerator's shared shadow map,
        // marked `_ownsDepthTexture: false`) must outlive per-task render targets that render into it.
        if (rt._ownsDepthTexture !== false) {
            rt._depthTexture.destroy();
        }
        rt._depthTexture = null;
        rt._depthView = null;
    }
    rt._width = 0;
    rt._height = 0;
}

function resolveSize(desc: RenderTargetDescriptor, engine: EngineContext): { width: number; height: number } {
    if (desc.size === "canvas") {
        return { width: engine.canvas.width, height: engine.canvas.height };
    }
    return desc.size;
}
