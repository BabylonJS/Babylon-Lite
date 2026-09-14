/**
 * Render-to-texture helper — eager allocation of a render target's GPU
 * textures so the color attachment, or depth attachment for depth-only targets,
 * can be exposed as a sampled texture BEFORE the frame graph is built.
 */

import type { EngineContext } from "../engine/engine.js";
import { getBilinearSampler, getNearestSampler } from "../resource/samplers.js";
import { acquireGPUTexture, _textureOwners, releaseGPUTexture } from "../resource/gpu-pool.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import type { RenderTarget, RenderTargetDescriptor } from "../engine/render-target.js";
import { createRenderTarget, buildRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import type { Texture2D } from "./texture-2d.js";
import { _replaceTextureBacking, _shareTextureBacking } from "./texture-backing.js";

/** Eager render-target allocation and sampled attachment facades. */
export interface RenderTargetTextureResult {
    readonly rt: RenderTarget;
    /** Color attachment, or the depth attachment for a depth-only target. */
    readonly texture: Texture2D;
    /** Depth-only sampled view when the target has a depth attachment. */
    readonly depthTexture: Texture2D | null;
    /** @internal */
    _resizeCallbacks?: (() => void)[];
    /** @internal */
    _disposed?: boolean;
}

function createDepthTexture(engine: EngineContext, rt: RenderTarget, width: number, height: number): Texture2D | null {
    if (!rt._depthTexture) {
        return null;
    }
    return {
        texture: rt._depthTexture,
        view: rt._depthTexture.createView({ aspect: "depth-only" }),
        sampler: getNearestSampler(engine),
        width,
        height,
        invertY: false,
        _sampleType: "depth",
    };
}

/** Eagerly allocate a render target's GPU textures and return stable sampled-texture facades.
 *  Surface-sized targets refresh their attachments and mutate those facades during frame-graph rebuilds. */
export function createRenderTargetTexture(engine: EngineContext, descriptor: RenderTargetDescriptor): RenderTargetTextureResult {
    const rt = createRenderTarget(descriptor);
    try {
        buildRenderTarget(rt, engine);
        const depthTexture = createDepthTexture(engine, rt, rt._width, rt._height);
        const texture: Texture2D | null =
            rt._colorTexture && rt._colorView
                ? {
                      texture: rt._colorTexture,
                      view: rt._colorView,
                      sampler: getBilinearSampler(engine),
                      width: rt._width,
                      height: rt._height,
                      invertY: true,
                  }
                : depthTexture;
        if (!texture) {
            throw new Error("createRenderTargetTexture: render target has no color or depth texture (no format / depthStencilFormat?).");
        }
        _shareTextureBacking(texture);
        if (depthTexture && depthTexture !== texture) {
            _shareTextureBacking(depthTexture);
        }
        const result: RenderTargetTextureResult = { rt, texture, depthTexture };
        installSurfaceResizeSync(engine, result);
        if (rt._colorTexture) {
            acquireGPUTexture(rt._colorTexture);
        }
        if (rt._depthTexture) {
            acquireGPUTexture(rt._depthTexture);
        }
        rt._eager = true;
        return result;
    } catch (error) {
        disposeRenderTarget(rt);
        throw error;
    }
}

function installSurfaceResizeSync(engine: EngineContext, result: RenderTargetTextureResult): void {
    const { rt, texture, depthTexture } = result;
    const size = rt._descriptor.size;
    rt._disposeAttachments = (): void => {
        if (result._disposed) {
            return;
        }
        result._disposed = true;
        const color = rt._colorTexture;
        const depth = rt._depthTexture;
        rt._colorTexture = rt._depthTexture = null;
        rt._colorView = rt._depthView = null;
        rt._width = rt._height = 0;
        if (color) {
            releaseGPUTexture(color);
        }
        if (depth) {
            releaseGPUTexture(depth);
        }
        if (result._resizeCallbacks) {
            result._resizeCallbacks.length = 0;
        }
    };
    let allocationDevice = engine._device;
    rt._syncEager = (currentEngine): void => {
        if (result._disposed) {
            throw new Error("RenderTargetTexture has been disposed.");
        }
        if (!("canvas" in size)) {
            return;
        }
        const canvas = size.canvas;
        if (allocationDevice === currentEngine._device && rt._width === canvas.width && rt._height === canvas.height) {
            return;
        }
        const oldColor = rt._colorTexture;
        const oldDepth = rt._depthTexture;
        const replacement = createRenderTarget(rt._descriptor);
        let replacementDepthView: GPUTextureView | null = null;
        try {
            buildRenderTarget(replacement, currentEngine);
            if (!!replacement._colorTexture !== !!oldColor || !!replacement._depthTexture !== !!oldDepth) {
                throw new Error("RenderTargetTexture attachment configuration cannot change during resize.");
            }
            replacementDepthView = replacement._depthTexture?.createView({ aspect: "depth-only" }) ?? null;
        } catch (error) {
            disposeRenderTarget(replacement);
            throw error;
        }
        rt._colorTexture = replacement._colorTexture;
        rt._colorView = replacement._colorView;
        rt._depthTexture = replacement._depthTexture;
        rt._depthView = replacement._depthView;
        rt._width = replacement._width;
        rt._height = replacement._height;
        allocationDevice = currentEngine._device;
        const replacementColor = rt._colorTexture as GPUTexture | null;
        const replacementColorView = rt._colorView as GPUTextureView | null;
        if (oldColor && replacementColor && replacementColorView) {
            replaceTextureFacade(currentEngine, texture, oldColor, replacementColor, replacementColorView, rt._width, rt._height);
        }
        const replacementDepth = rt._depthTexture as GPUTexture | null;
        if (oldDepth && replacementDepth && depthTexture && replacementDepthView) {
            replaceTextureFacade(currentEngine, depthTexture, oldDepth, replacementDepth, replacementDepthView, rt._width, rt._height);
        }
        for (const callback of result._resizeCallbacks ?? []) {
            callback();
        }
    };
}

/** Release the target's attachment ownership. Sampled consumers may retain its last image.
 *  Owning render tasks call this lifecycle automatically; use it directly for targets without a task owner. */
export function disposeRenderTargetTexture(result: RenderTargetTextureResult): void {
    disposeRenderTarget(result.rt);
}

/** Invoke `callback` after a surface-sized render-target texture replaces its GPU attachments.
 *  Use it to rebuild material bindings that capture the sampled view. Returns an unregister function. */
export function onRenderTargetTextureResize(result: RenderTargetTextureResult, callback: () => void): () => void {
    if (result._disposed) {
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
