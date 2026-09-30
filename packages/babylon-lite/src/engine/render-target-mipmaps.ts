import type { EngineContext } from "./engine.js";
import { runGpuResourceCallbacks } from "./gpu-resource-retirement.js";
import { buildRenderTarget, createRenderTarget, disposeRenderTarget, _resolveRenderTargetSize, type RenderTarget, type RenderTargetDescriptor } from "./render-target.js";
import { mipLevelCount } from "../texture/mip-count.js";
import { supportsMipmapFormat } from "../texture/mipmap-format.js";

/** Create an owned, single-sample color render target with a full mip chain.
 * Allocation is deferred until a frame-graph build and follows surface resize. */
export function createMipMappedRenderTarget(descriptor: RenderTargetDescriptor): RenderTarget {
    if (!descriptor.format || descriptor.samples !== 1) {
        throw new Error("createMipMappedRenderTarget requires a color format and samples: 1.");
    }
    const target = createRenderTarget(descriptor);
    let device: GPUDevice | null = null;
    target._eager = true;
    target._syncEager = function (engine: EngineContext): void {
        if (this._disposed) {
            throw new Error("Mipmapped render target has been disposed.");
        }
        const { width, height } = _resolveRenderTargetSize(this._descriptor);
        const desc = this._descriptor;
        if (desc.samples !== 1 || !desc.format || !supportsMipmapFormat(engine, desc.format)) {
            throw new Error("Mipmapped render target requires a single-sample, filterable, renderable color format.");
        }
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
            throw new Error("Mipmapped render target dimensions must be positive integers.");
        }
        if (width > engine._device.limits.maxTextureDimension2D || height > engine._device.limits.maxTextureDimension2D) {
            throw new Error("Mipmapped render target dimensions exceed maxTextureDimension2D.");
        }
        if (
            this._colorTexture?.format === desc.format &&
            this._depthTexture?.format === desc.dFormat &&
            device === engine._device &&
            this._width === width &&
            this._height === height
        ) {
            return;
        }
        const replacement = createRenderTarget(desc);
        let samplingView: GPUTextureView | null;
        try {
            buildRenderTarget(replacement, engine, mipLevelCount(width, height));
            samplingView = replacement._colorView;
            replacement._colorView = replacement._colorTexture!.createView({ baseMipLevel: 0, mipLevelCount: 1 });
        } catch (error) {
            runGpuResourceCallbacks([() => disposeRenderTarget(replacement)]);
            throw error;
        }
        const previousColor = this._colorTexture;
        const previousDepth = this._depthTexture;
        this._colorTexture = replacement._colorTexture;
        this._colorView = replacement._colorView;
        this._colorSamplingView = samplingView;
        this._depthTexture = replacement._depthTexture;
        this._depthView = replacement._depthView;
        this._width = replacement._width;
        this._height = replacement._height;
        device = engine._device;
        try {
            previousColor?.destroy();
        } finally {
            previousDepth?.destroy();
        }
    };
    target._disposeAttachments = function (color, depth): void {
        this._disposed = true;
        this._colorSamplingView = null;
        try {
            color?.destroy();
        } finally {
            depth?.destroy();
        }
    };
    return target;
}
