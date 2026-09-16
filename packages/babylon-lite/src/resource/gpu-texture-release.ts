import { releaseTextureAllocation } from "./texture-allocation-release.js";

/** Decrement ownership of a raw GPUTexture without a facade notification. */
export function releaseGPUTexture(texture: GPUTexture): boolean {
    return releaseTextureAllocation(texture);
}
