import type { EngineContext } from "../engine/engine.js";

/** @internal Whether a format supports the filtering and color rendering used by mipmap blits. */
export function supportsMipmapFormat(engine: EngineContext, format: GPUTextureFormat): boolean {
    switch (format) {
        case "r8unorm":
        case "r16float":
        case "rg8unorm":
        case "rg16float":
        case "rgba8unorm":
        case "rgba8unorm-srgb":
        case "bgra8unorm":
        case "bgra8unorm-srgb":
        case "rgb10a2unorm":
        case "rgba16float":
            return true;
        case "r32float":
        case "rg32float":
        case "rgba32float":
            return engine._device.features.has("float32-filterable");
        case "rg11b10ufloat":
            return engine._device.features.has("rg11b10ufloat-renderable");
        case "r8snorm":
        case "rg8snorm":
        case "rgba8snorm":
            return engine._device.features.has("texture-formats-tier1");
        default:
            return false;
    }
}
