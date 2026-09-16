/**
 * Render-to-texture helper — eager allocation of a render target's GPU
 * textures so the color attachment, or depth attachment for depth-only targets,
 * can be exposed as a sampled texture BEFORE the frame graph is built.
 */

import type { EngineContext } from "../engine/engine.js";
import { runGpuResourceCallbacks } from "../engine/gpu-resource-retirement.js";
import { getBilinearSampler } from "../resource/samplers.js";
import { acquireGPUTexture } from "../resource/gpu-texture-acquire.js";
import { releaseGPUTexture } from "../resource/gpu-texture-release.js";
import type { RenderTarget, RenderTargetDescriptor } from "../engine/render-target.js";
import { createRenderTarget, buildRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import type { Texture2D } from "./texture-2d.js";

/** Eager render-target allocation and sampled attachment facades. */
export interface RenderTargetTextureResult {
    readonly rt: RenderTarget;
    /** Color attachment, or the depth attachment for a depth-only target. */
    readonly texture: Texture2D;
    /** Sampled depth facade when explicitly requested with `withSampledDepthTexture`. */
    readonly depthTexture: Texture2D | null;
    /** @internal Independent surface-resize subscriptions and their pending delivery state. */
    _resizeCallbacks?: Set<{ readonly callback: () => void; pending: boolean }>;
}

/** Optional RTT depth-facade provider, such as `withSampledDepthTexture`. */
export type RenderTargetDepthSampler = (engine: EngineContext, target: RenderTarget) => Texture2D;

function releaseAttachments(this: RenderTarget, color: GPUTexture | null, depth: GPUTexture | null): void {
    this._disposed = true;
    try {
        if (color) {
            releaseGPUTexture(color);
        }
    } finally {
        if (depth) {
            releaseGPUTexture(depth);
        }
    }
}

function checkTargetOwnership(this: RenderTarget): void {
    if (this._disposed) {
        throw new Error("RenderTargetTexture has been disposed.");
    }
}

/** @internal Shared eager allocation and attachment ownership for fixed and surface RTT factories. */
export function _createRenderTargetTexture(engine: EngineContext, descriptor: RenderTargetDescriptor, sampleDepth?: RenderTargetDepthSampler): RenderTargetTextureResult {
    const hasColor = !!descriptor.format;
    if (!hasColor && !sampleDepth) {
        throw new Error("Depth-only render-target textures require withSampledDepthTexture as the third argument.");
    }
    const rt = createRenderTarget(descriptor);
    try {
        buildRenderTarget(rt, engine);
        const depthTexture = sampleDepth?.(engine, rt) ?? null;
        const texture: Texture2D | null = hasColor
            ? {
                  texture: rt._colorTexture!,
                  view: rt._colorView!,
                  sampler: getBilinearSampler(engine),
                  width: rt._width,
                  height: rt._height,
                  invertY: true,
              }
            : depthTexture;
        if (!texture) {
            throw new Error("createRenderTargetTexture: render target has no color or depth texture (no format / depthStencilFormat?).");
        }
        const result: RenderTargetTextureResult = { rt, texture, depthTexture };
        rt._disposeAttachments = releaseAttachments;
        rt._syncEager = checkTargetOwnership;
        for (const attachment of [rt._colorTexture, rt._depthTexture]) {
            if (attachment) {
                acquireGPUTexture(attachment);
            }
        }
        rt._eager = true;
        return result;
    } catch (error) {
        runGpuResourceCallbacks([() => disposeRenderTarget(rt)]);
        throw error;
    }
}

/** Eagerly allocate a fixed-size render target and expose sampled attachment facades. */
export function createRenderTargetTexture(engine: EngineContext, descriptor: RenderTargetDescriptor, sampleDepth?: RenderTargetDepthSampler): RenderTargetTextureResult {
    if ("canvas" in descriptor.size) {
        throw new Error(
            "createRenderTargetTexture: descriptor.size must be fixed { width, height } pixels, not a SurfaceContext; use createSurfaceRenderTargetTexture for surface-resizing targets."
        );
    }
    return _createRenderTargetTexture(engine, descriptor, sampleDepth);
}

/** Release the target's attachment ownership. Sampled consumers may retain its last image.
 *  Owning render tasks call this lifecycle automatically; use it directly for targets without a task owner. */
export function disposeRenderTargetTexture(result: RenderTargetTextureResult): void {
    disposeRenderTarget(result.rt);
}
