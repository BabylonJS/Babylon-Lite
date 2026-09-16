import type { EngineContext } from "../engine/engine.js";
import { retireGpuResources, runGpuResourceCallbacks } from "../engine/gpu-resource-retirement.js";
import type { RenderTargetDescriptor } from "../engine/render-target.js";
import { buildRenderTarget, createRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
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
): RenderTargetTextureResult {
    const result = _createRenderTargetTexture(engine, descriptor, sampleDepth);
    try {
        _shareTextureBacking(result.texture);
        if (result.depthTexture && result.depthTexture !== result.texture) {
            _shareTextureBacking(result.depthTexture);
        }
        installSurfaceResizeSync(engine, descriptor.size, result);
        return result;
    } catch (error) {
        runGpuResourceCallbacks([() => disposeRenderTargetTexture(result)]);
        throw error;
    }
}

function installSurfaceResizeSync(engine: EngineContext, surface: SurfaceContext, result: RenderTargetTextureResult): void {
    const { rt, texture, depthTexture } = result;
    const depthFacade = depthTexture;
    const callbacks = (result._resizeCallbacks ??= []);
    const disposeAttachments = rt._disposeAttachments!;
    rt._disposeAttachments = (color, depth): void => {
        callbacks.length = 0;
        disposeAttachments.call(rt, color, depth);
    };
    let allocationDevice = engine._device;
    rt._syncEager = (currentEngine): void => {
        if (rt._disposed) {
            throw new Error("RenderTargetTexture has been disposed.");
        }
        const canvas = surface.canvas;
        if (allocationDevice === currentEngine._device && rt._width === canvas.width && rt._height === canvas.height) {
            return;
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
            replaceTextureFacade(currentEngine, texture, oldColor, replacementColor, replacementColorView, rt._width, rt._height);
        }
        const replacementDepth = rt._depthTexture;
        if (oldDepth && replacementDepth && depthFacade && replacementDepthView) {
            replaceTextureFacade(currentEngine, depthFacade, oldDepth, replacementDepth, replacementDepthView, rt._width, rt._height);
        } else if (oldDepth && replacementDepth) {
            acquireGPUTexture(replacementDepth);
            retireGpuResources(currentEngine, () => releaseGPUTexture(oldDepth));
        }
        for (const callback of callbacks) {
            callback();
        }
    };
}

/** Invoke `callback` after a surface-sized render-target texture replaces its GPU attachments.
 *  Use it to rebuild material bindings that capture the sampled view. Returns an unregister function. */
export function onRenderTargetTextureResize(result: RenderTargetTextureResult, callback: () => void): () => void {
    if (result.rt._disposed) {
        throw new Error("RenderTargetTexture has been disposed.");
    }
    const callbacks = (result._resizeCallbacks ??= []);
    callbacks.push(callback);
    return () => {
        const index = callbacks.indexOf(callback);
        if (index >= 0) {
            callbacks.splice(index, 1);
        }
    };
}

function replaceTextureFacade(engine: EngineContext, facade: Texture2D, oldTexture: GPUTexture, texture: GPUTexture, view: GPUTextureView, width: number, height: number): void {
    const owners = _textureOwners(facade);
    for (let owner = 0; owner < owners; owner++) {
        acquireGPUTexture(texture);
    }
    _replaceTextureBacking(facade, texture, view, width, height);
    retireGpuResources(engine, () => {
        if (owners === 0) {
            oldTexture.destroy();
            return;
        }
        for (let owner = 0; owner < owners; owner++) {
            releaseGPUTexture(oldTexture);
        }
    });
}
