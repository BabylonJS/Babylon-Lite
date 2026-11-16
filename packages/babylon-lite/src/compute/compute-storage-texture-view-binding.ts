import type { ComputeStorageTextureViewDimension } from "../resource/compute-storage-texture.js";
import type { ComputeBindingDecl } from "./compute-binding.js";
import { _computeStorageTextureViewBinding } from "./compute-storage-texture-binding.js";

/** Advanced storage-texture declaration options. */
export interface ComputeStorageTextureViewBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly format: GPUTextureFormat;
    readonly access: GPUStorageTextureAccess;
    readonly viewDimension: ComputeStorageTextureViewDimension;
}

/** Declare a storage texture with explicit dimension and access. */
export function computeStorageTextureViewBinding(name: string, options: ComputeStorageTextureViewBindingOptions): ComputeBindingDecl {
    return _computeStorageTextureViewBinding(name, options);
}
