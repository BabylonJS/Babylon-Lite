import type { EngineContext } from "../engine/engine.js";
import { flushGpuResourceRetirements, retireGpuResources, runGpuResourceCallbacks } from "../engine/gpu-resource-retirement.js";
import type { RenderTargetDescriptor, RenderTargetSurfaceSize } from "../engine/render-target.js";
import { _getRenderTargetSurface, _resolveRenderTargetSize, buildRenderTarget, createRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import type { SurfaceContext } from "../engine/surface.js";
import { acquireGPUTexture } from "../resource/gpu-texture-acquire.js";
import { releaseGPUTexture } from "../resource/gpu-texture-release.js";
import { _textureOwners } from "../resource/texture-owner-state.js";
import { _createRenderTargetTexture, disposeRenderTargetTexture, type RenderTargetDepthSampler, type RenderTargetTextureResult } from "./rtt.js";
import type { Texture2D } from "./texture-2d.js";
import { _replaceTextureBacking, _shareTextureBacking } from "./texture-backing.js";

/** Eagerly allocate a surface-sized render target whose sampled facades follow resize replacements. */
export function createSurfaceRenderTargetTexture(
    engine: EngineContext,
    descriptor: RenderTargetDescriptor & { size: SurfaceContext },
    sampleDepth?: RenderTargetDepthSampler
): RenderTargetTextureResult;
export function createSurfaceRenderTargetTexture(
    engine: EngineContext,
    descriptor: RenderTargetDescriptor & { size: SurfaceContext | RenderTargetSurfaceSize },
    sampleDepth?: RenderTargetDepthSampler
): RenderTargetTextureResult;
export function createSurfaceRenderTargetTexture(
    engine: EngineContext,
    descriptor: RenderTargetDescriptor & { size: SurfaceContext | RenderTargetSurfaceSize },
    sampleDepth?: RenderTargetDepthSampler
): RenderTargetTextureResult {
    if (!_getRenderTargetSurface(descriptor.size)) {
        throw new Error("createSurfaceRenderTargetTexture: descriptor.size must be a SurfaceContext or { surface, scale }.");
    }
    const result = _createRenderTargetTexture(engine, descriptor, sampleDepth);
    try {
        _shareTextureBacking(result.texture);
        if (result.depthTexture && result.depthTexture !== result.texture) {
            _shareTextureBacking(result.depthTexture);
        }
        installSurfaceResizeSync(engine, result);
        return result;
    } catch (error) {
        runGpuResourceCallbacks([() => disposeRenderTargetTexture(result)]);
        throw error;
    }
}

function installSurfaceResizeSync(engine: EngineContext, result: RenderTargetTextureResult): void {
    const { rt, texture, depthTexture } = result;
    const depthFacade = depthTexture;
    const callbacks = (result._resizeCallbacks ??= new Set());
    let notificationPending = false;
    let notifying = false;
    let retiredAttachments: (() => void)[] = [];
    const retireReplacements = (currentEngine: EngineContext): void => {
        if (retiredAttachments.length) {
            const retired = retiredAttachments;
            retireGpuResources(currentEngine, () => runGpuResourceCallbacks(retired));
            retiredAttachments = [];
            flushGpuResourceRetirements(currentEngine);
        }
    };
    const settleResizeCallbacks = (currentEngine = engine): void => {
        if (notifying) {
            return;
        }
        if (notificationPending) {
            notificationPending = false;
            for (const observer of callbacks) {
                if (observer.pending) {
                    notificationPending = true;
                    break;
                }
            }
        }
        if (!notificationPending) {
            retireReplacements(currentEngine);
        }
    };
    result._settleResizeCallbacks = settleResizeCallbacks;
    const notifyResize = (currentEngine: EngineContext): void => {
        if (notifying) {
            return;
        }
        let errors: unknown[] | undefined;
        if (notificationPending) {
            notifying = true;
            try {
                for (const observer of callbacks) {
                    if (!observer.pending) {
                        continue;
                    }
                    try {
                        const callback = observer.callback;
                        callback();
                        observer.pending = false;
                    } catch (error) {
                        (errors ??= []).push(error);
                    }
                }
            } finally {
                notifying = false;
            }
        }
        settleResizeCallbacks(currentEngine);
        if (errors) {
            throw errors.length === 1 ? errors[0] : new AggregateError(errors, "RenderTargetTexture resize callbacks failed.");
        }
    };
    const disposeAttachments = rt._disposeAttachments!;
    rt._disposeAttachments = (color, depth): void => {
        callbacks.clear();
        notificationPending = false;
        try {
            disposeAttachments.call(rt, color, depth);
        } finally {
            retireReplacements(engine);
        }
    };
    let allocationDevice = engine._device;
    rt._syncEager = (currentEngine): void => {
        if (rt._disposed) {
            throw new Error("RenderTargetTexture has been disposed.");
        }
        const size = _resolveRenderTargetSize(rt._descriptor);
        if (allocationDevice === currentEngine._device && rt._width === size.width && rt._height === size.height) {
            notifyResize(currentEngine);
            return;
        }
        if (notifying) {
            throw new Error("RenderTargetTexture cannot resize recursively from a resize callback.");
        }
        const oldColor = rt._colorTexture;
        const oldDepth = rt._depthTexture;
        const replacement = createRenderTarget(rt._descriptor);
        let replacementDepthView: GPUTextureView | null = null;
        try {
            buildRenderTarget(replacement, currentEngine);
            if (
                !!replacement._colorTexture !== !!oldColor ||
                !!replacement._depthTexture !== !!oldDepth ||
                replacement._colorTexture?.sampleCount !== oldColor?.sampleCount ||
                replacement._depthTexture?.sampleCount !== oldDepth?.sampleCount
            ) {
                throw new Error("RenderTargetTexture attachment configuration cannot change during resize.");
            }
            replacementDepthView = depthFacade ? replacement._depthTexture!.createView({ aspect: "depth-only" }) : null;
        } catch (error) {
            runGpuResourceCallbacks([() => disposeRenderTarget(replacement)]);
            throw error;
        }
        rt._colorTexture = replacement._colorTexture;
        rt._colorView = replacement._colorView;
        rt._depthTexture = replacement._depthTexture;
        rt._depthView = replacement._depthView;
        rt._width = replacement._width;
        rt._height = replacement._height;
        allocationDevice = currentEngine._device;
        const replacementColor = rt._colorTexture;
        const replacementColorView = rt._colorView;
        if (oldColor && replacementColor && replacementColorView) {
            retiredAttachments.push(replaceTextureFacade(texture, oldColor, replacementColor, replacementColorView, rt._width, rt._height));
        }
        const replacementDepth = rt._depthTexture;
        if (oldDepth && replacementDepth && depthFacade && replacementDepthView) {
            retiredAttachments.push(replaceTextureFacade(depthFacade, oldDepth, replacementDepth, replacementDepthView, rt._width, rt._height));
        } else if (oldDepth && replacementDepth) {
            acquireGPUTexture(replacementDepth);
            retiredAttachments.push(() => releaseGPUTexture(oldDepth));
        }
        for (const observer of callbacks) {
            observer.pending = true;
        }
        notificationPending = true;
        notifyResize(currentEngine);
    };
}

/** Invoke `callback` after a surface-sized render-target texture replaces its GPU attachments.
 *  Every registered consumer is attempted even if another throws. Failed callbacks retry on
 *  the next target build, including unchanged-size builds; successful callbacks are not repeated.
 *  Old attachments remain alive until delivery completes, then retire behind a GPU fence.
 *  Returns an unregister function that cancels its retry and starts retirement when delivery
 *  has no pending observers, without requiring another target build. A consumer canceling a
 *  pending retry must stop using its superseded views. */
export function onRenderTargetTextureResize(result: RenderTargetTextureResult, callback: () => void): () => void {
    if (result.rt._disposed) {
        throw new Error("RenderTargetTexture has been disposed.");
    }
    const callbacks = (result._resizeCallbacks ??= new Set());
    const observer = { callback, pending: false };
    callbacks.add(observer);
    return () => {
        if (callbacks.delete(observer)) {
            result._settleResizeCallbacks?.();
        }
    };
}

function replaceTextureFacade(facade: Texture2D, oldTexture: GPUTexture, texture: GPUTexture, view: GPUTextureView, width: number, height: number): () => void {
    const owners = _textureOwners(facade);
    for (let owner = 0; owner < owners; owner++) {
        acquireGPUTexture(texture);
    }
    _replaceTextureBacking(facade, texture, view, width, height);
    return () => {
        if (owners === 0) {
            oldTexture.destroy();
            return;
        }
        for (let owner = 0; owner < owners; owner++) {
            releaseGPUTexture(oldTexture);
        }
    };
}
