import { TU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { createRenderTarget } from "../engine/render-target.js";
import { acquireTexture } from "../resource/texture-acquire.js";
import { releaseTexture } from "../resource/texture-release.js";
import type { Texture2D } from "./texture-2d.js";

/** Subresource selected by {@link createTextureRenderTarget}. */
export interface TextureRenderTargetOptions {
    /** Array layer to render into. Default 0. */
    readonly layer?: number;
    /** Mip level to render into. Default 0. */
    readonly mipLevel?: number;
}

function attach(target: RenderTarget, texture: Texture2D, layer: number, mipLevel: number): void {
    const gpu = texture.texture;
    const view = gpu.createView({ dimension: "2d", baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: mipLevel, mipLevelCount: 1 });
    if (target._descriptor.dFormat) {
        target._depthTexture = gpu;
        target._depthView = view;
    } else {
        target._colorTexture = gpu;
        target._colorView = view;
    }
}

/**
 * Wrap one layer and mip level of an existing renderable texture as a `RenderTarget`, so a frame-graph task
 * (a render-draw task, an effect task, a clear) can draw into it: a tile slot of a texture array, a mip of a
 * pyramid, or a plain render texture of any size and format.
 *
 * The target holds one reference on the texture (released by `disposeRenderTarget`) and owns no attachment:
 * disposing it never destroys the texture another owner still uses. One target per subresource is created
 * once and reused; switching a task between targets of the same format allocates nothing.
 */
export function createTextureRenderTarget(_engine: EngineContext, texture: Texture2D, options?: TextureRenderTargetOptions): RenderTarget {
    const gpu = texture.texture;
    const layer = options?.layer ?? 0;
    const mipLevel = options?.mipLevel ?? 0;
    if ((gpu.usage & TU.RENDER_ATTACHMENT) === 0) {
        throw new Error("createTextureRenderTarget: the texture was not created with render-attachment usage.");
    }
    if (gpu.dimension !== "2d") {
        throw new Error(`createTextureRenderTarget: ${gpu.dimension} textures cannot be render targets.`);
    }
    if (!Number.isInteger(layer) || layer < 0 || layer >= gpu.depthOrArrayLayers) {
        throw new Error(`createTextureRenderTarget: layer must be an integer in [0, ${gpu.depthOrArrayLayers}), received ${layer}.`);
    }
    if (!Number.isInteger(mipLevel) || mipLevel < 0 || mipLevel >= gpu.mipLevelCount) {
        throw new Error(`createTextureRenderTarget: mipLevel must be an integer in [0, ${gpu.mipLevelCount}), received ${mipLevel}.`);
    }
    const width = Math.max(1, gpu.width >> mipLevel);
    const height = Math.max(1, gpu.height >> mipLevel);
    const depth = gpu.format.startsWith("depth") || gpu.format === "stencil8";
    const target = createRenderTarget({
        lbl: gpu.label,
        format: depth ? undefined : gpu.format,
        dFormat: depth ? gpu.format : undefined,
        samples: gpu.sampleCount,
        size: { width, height },
    });
    attach(target, texture, layer, mipLevel);
    target._width = width;
    target._height = height;
    target._eager = true;
    // Re-attach when the facade's GPU texture was replaced in place (device-lost recovery rebuilds it).
    target._syncEager = function (this: RenderTarget): void {
        if (this._disposed) {
            throw new Error("Texture render target has been disposed.");
        }
        if ((this._colorTexture ?? this._depthTexture) !== texture.texture) {
            attach(this, texture, layer, mipLevel);
        }
    };
    target._disposeAttachments = function (this: RenderTarget): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        releaseTexture(texture);
    };
    acquireTexture(texture);
    return target;
}
