import type { ComputeBindingDecl } from "./compute-binding.js";
import type { ComputeTextureBindingOptions } from "./compute-texture-binding.js";
import { _computeTextureViewBinding } from "./compute-texture-binding.js";

/** Sampled-texture declaration with an explicit WebGPU view dimension. */
export interface ComputeTextureViewBindingOptions extends ComputeTextureBindingOptions {
    readonly viewDimension: GPUTextureViewDimension;
}

/** Declare a sampled texture view other than the compact default 2D path. */
export function computeTextureViewBinding(name: string, options: ComputeTextureViewBindingOptions): ComputeBindingDecl {
    return _computeTextureViewBinding(name, options);
}
