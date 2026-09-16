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
import type { SurfaceContext } from "./surface.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { DrawBatchState } from "../render/draw-update-batches.js";
import type { DrawBinding } from "../render/renderable.js";

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
    /** @internal Collection and lifecycle behavior installed only by update-batch features. */
    _collectBatches?: (state: DrawBatchState | undefined, binding: DrawBinding) => DrawBatchState | undefined;
}

/** Description of a render target — what to create, not the GPU objects themselves. */
export const REVERSE_DEPTH_COMPARE = "greater-equal" as GPUCompareFunction;

/** Surface-relative render-target dimensions. The scale is applied to the live
 *  surface backing size on every build, floored per axis, and clamped to at
 *  least one pixel. */
export interface RenderTargetSurfaceSize {
    readonly surface: SurfaceContext;
    readonly scale: number;
}

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
    /** A `SurfaceContext` for full surface dimensions, `{ surface, scale }` for
     *  scaled live dimensions, or explicit `{ width, height }` device pixels.
     *  Surface-backed sizes are re-resolved on every `buildRenderTarget`. */
    size: SurfaceContext | RenderTargetSurfaceSize | { width: number; height: number };
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
    /** True when textures were allocated eagerly (before frame graph build).
     *  Fixed targets make `buildRenderTarget` a no-op; surface-sized sampled
     *  targets use `_syncEager` to refresh stable Texture2D facades on resize. */
    /** @internal */
    _eager?: boolean;
    /** @internal Optional in-place eager attachment refresh used by sampled surface-sized targets. */
    _syncEager?(this: RenderTarget, engine: EngineContext): void;
    /** @internal Release the captured, already-detached attachment-owner references.
     *  Externally owned eager wrappers leave this absent. */
    _disposeAttachments?(this: RenderTarget, color: GPUTexture | null, depth: GPUTexture | null): void;
    /** @internal Sampled-target writer ownership has been released. */
    _disposed?: boolean;
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

/** Allocate GPU textures for the render target. Idempotent for fixed eager targets;
 *  surface-sized eager targets may synchronize through `_syncEager`. A
 *  color texture is allocated whenever the descriptor has a `format`; depth
 *  is allocated whenever it has a `depthStencilFormat`. */
export function buildRenderTarget(rt: RenderTarget, engine: EngineContext): void {
    if (rt._eager) {
        rt._syncEager?.(engine);
        return;
    }
    disposeRenderTarget(rt);

    const desc = rt._descriptor;
    const { width, height } = _resolveRenderTargetSize(desc);
    rt._width = width;
    rt._height = height;

    const device = engine._device;
    if (desc.format) {
        rt._colorTexture = device.createTexture({
            label: desc.lbl,
            size: { width, height },
            format: desc.format,
            sampleCount: desc.samples,
            usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING | TU.COPY_SRC | TU.COPY_DST,
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

/** Free owned attachments, including sampled eager targets with an explicit owner hook.
 *  Eager wrappers without a hook (swapchain, geometry/shadow outputs) remain externally owned. */
export function disposeRenderTarget(rt: RenderTarget | null | undefined): void {
    if (!rt || (rt._eager && !rt._disposeAttachments)) {
        return;
    }
    const color = rt._colorTexture;
    const depth = rt._depthTexture;
    rt._colorTexture = rt._depthTexture = null;
    rt._colorView = rt._depthView = null;
    rt._width = rt._height = 0;
    if (rt._disposeAttachments) {
        rt._disposeAttachments(color, depth);
    } else {
        try {
            color?.destroy();
        } finally {
            // A shared shadow map may supply borrowed depth to an otherwise owning target.
            if (rt._ownsDepthTexture !== false) {
                depth?.destroy();
            }
        }
    }
}

/** @internal Return the live surface behind a surface-sized descriptor, if any. */
export function _getRenderTargetSurface(size: RenderTargetDescriptor["size"]): SurfaceContext | null {
    if ("canvas" in size) {
        return size;
    }
    return "surface" in size ? size.surface : null;
}

/** @internal Resolve the descriptor's current allocation dimensions. */
export function _resolveRenderTargetSize(desc: RenderTargetDescriptor): { width: number; height: number } {
    const size = desc.size;
    if ("canvas" in size) {
        return size.canvas;
    }
    if ("surface" in size) {
        if (!Number.isFinite(size.scale) || size.scale <= 0) {
            throw new Error(`RenderTargetDescriptor.size.scale must be a positive finite number (got ${size.scale}).`);
        }
        const canvas = size.surface.canvas;
        return {
            width: Math.max(1, Math.floor((canvas.width || 1) * size.scale)),
            height: Math.max(1, Math.floor((canvas.height || 1) * size.scale)),
        };
    }
    return size;
}
