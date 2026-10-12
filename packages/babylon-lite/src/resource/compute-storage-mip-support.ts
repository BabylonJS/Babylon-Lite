import type { ComputeStorageTextureViewDimension } from "./compute-storage-texture.js";
import type { EngineContext } from "../engine/engine.js";

/** @internal Shared capability predicate for render-based compute-texture mip generation. */
export function _supportsComputeRenderMipmaps(engine: EngineContext, viewDimension: ComputeStorageTextureViewDimension, format: GPUTextureFormat, sampled: boolean): boolean {
    return (
        sampled &&
        viewDimension === "2d" &&
        (format === "rgba8unorm" || format === "rgba16float" || (format === "rgba8snorm" && engine._device.features.has("texture-formats-tier1")))
    );
}
