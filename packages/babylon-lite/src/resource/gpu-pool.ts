/** Side-effect-free facade for pooled GPU resource operations. */

export { acquireGPUTexture } from "./gpu-texture-acquire.js";
export { releaseGPUTexture } from "./gpu-texture-release.js";
export { acquireTexture } from "./texture-acquire.js";
export { releaseTexture } from "./texture-release.js";
export { _setTextureReleaseHook } from "./texture-allocation-release.js";
export { _isTextureReleased, _textureOwners } from "./texture-owner-state.js";
export { getOrCreateSampler, clearSamplerCache } from "./sampler-pool.js";
