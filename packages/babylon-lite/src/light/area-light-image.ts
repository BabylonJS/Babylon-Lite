import type { Texture2D } from "../texture/texture-2d.js";
import { TU } from "../engine/gpu-flags.js";
import { _isTextureReleased } from "../resource/texture-owner-state.js";

/** @internal Immutable provenance, shared by image wrappers but never scene-specific. */
export interface AreaLightImage {
    readonly device: GPUDevice;
    readonly texture: GPUTexture;
}

/** @internal Validate before acquiring or allocating resources. GPU validation checks device membership. */
export function validateAreaLightSource(source: Texture2D): void {
    const gpu = source?.texture;
    if (
        !gpu ||
        !source.view ||
        !source.sampler ||
        !Number.isSafeInteger(source.width) ||
        !Number.isSafeInteger(source.height) ||
        source.width < 1 ||
        source.height < 1 ||
        gpu.width !== source.width ||
        gpu.height !== source.height ||
        gpu.dimension !== "2d" ||
        gpu.depthOrArrayLayers !== 1 ||
        gpu.sampleCount !== 1 ||
        !(gpu.usage & TU.TEXTURE_BINDING) ||
        source._sampleType === "depth" ||
        /depth|stencil|sint|uint|32float/.test(gpu.format)
    ) {
        throw new Error("RectAreaLight: source must be a filterable, single-sampled color Texture2D with matching dimensions");
    }
    if (_isTextureReleased(source)) {
        throw new Error("RectAreaLight: texture was released");
    }
}

/** @internal Only processor-produced images on the current device may be assigned to lights. */
export function validateAreaLightImage(source: Texture2D, device: GPUDevice): void {
    validateAreaLightSource(source);
    const image = source._areaLightImage;
    if (!image || image.texture !== source.texture) {
        throw new Error("RectAreaLight: emissionTexture must be returned by processAreaLightTexture(engine, source)");
    }
    if (image.device !== device) {
        throw new Error("RectAreaLight: emissionTexture belongs to a different device; preprocess it on the current engine");
    }
    if (source.width !== 1024 || source.height !== 1024 || source.texture.format !== "rgba8unorm" || source.texture.mipLevelCount !== 11 || !(source.texture.usage & TU.COPY_SRC)) {
        throw new Error("RectAreaLight: incompatible processed emissionTexture");
    }
}
