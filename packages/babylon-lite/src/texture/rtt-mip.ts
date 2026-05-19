import type { EngineContextInternal } from "../engine/engine.js";
import type { RenderTarget, RenderTargetDescriptor } from "../engine/render-target.js";
import { createRenderTarget } from "../engine/render-target.js";
import { getTrilinearSampler } from "../resource/gpu-pool.js";
import type { Texture2D } from "./texture-2d.js";

export interface MipRenderTargetDescriptor extends Omit<RenderTargetDescriptor, "sampleCount" | "size"> {
    readonly colorFormat: GPUTextureFormat;
    readonly size: { width: number; height: number };
    readonly mipLevelCount: number;
}

export function createMipRenderTargetTexture(engine: EngineContextInternal, descriptor: MipRenderTargetDescriptor): { rt: RenderTarget; texture: Texture2D } {
    const rt = createRenderTarget({ ...descriptor, sampleCount: 1 });
    const { width, height } = descriptor.size;
    const colorTexture = engine.device.createTexture({
        label: descriptor.label,
        size: { width, height },
        format: descriptor.colorFormat,
        mipLevelCount: descriptor.mipLevelCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    rt._colorTexture = colorTexture;
    rt._colorView = colorTexture.createView({ baseMipLevel: 0, mipLevelCount: 1 });
    rt._width = width;
    rt._height = height;
    rt._eager = true;

    if (descriptor.depthStencilFormat) {
        rt._depthTexture = engine.device.createTexture({
            label: descriptor.label,
            size: { width, height },
            format: descriptor.depthStencilFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        rt._depthView = rt._depthTexture.createView();
    }

    return {
        rt,
        texture: {
            texture: colorTexture,
            view: colorTexture.createView(),
            sampler: getTrilinearSampler(engine),
            width,
            height,
            invertY: false,
        },
    };
}
