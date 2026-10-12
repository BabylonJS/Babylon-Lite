import type { EngineContext } from "../engine/engine.js";
import {
    _hasComputeStorageTexture,
    _isComputeStorageTextureFormat,
    type ComputeStorageTexture,
    type ComputeStorageTextureFormat,
    type ComputeStorageTextureViewDimension,
} from "../resource/compute-storage-texture.js";
import { _createComputeBindingDecl, _installComputeBindingResolver, type ComputeBindingDecl } from "./compute-binding.js";

const STORAGE_TEXTURE_KIND = 5;

/** Options for a compute storage-texture declaration. */
export interface ComputeStorageTextureBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly format: ComputeStorageTextureFormat;
}

interface StorageTextureBindingData {
    readonly format: GPUTextureFormat;
    readonly access: GPUStorageTextureAccess;
    readonly viewDimension: ComputeStorageTextureViewDimension;
}

function resolveStorageTexture(engine: EngineContext, decl: ComputeBindingDecl, input: unknown) {
    const resource = input as ComputeStorageTexture;
    const data = decl._data as StorageTextureBindingData;
    if (!resource || resource._engine !== engine || resource._destroyed || !_hasComputeStorageTexture(engine, resource)) {
        throw new Error(`ComputeBindingSet: storage texture for "${decl.name}" is invalid or belongs to a different engine.`);
    }
    if (resource.format !== data.format) {
        throw new Error(`ComputeBindingSet: storage texture "${decl.name}" has format ${resource.format}, expected ${data.format}.`);
    }
    if (resource.viewDimension !== data.viewDimension) {
        throw new Error(`ComputeBindingSet: storage texture "${decl.name}" uses a ${resource.viewDimension} view, expected ${data.viewDimension}.`);
    }
    if (!resource.accesses.includes(data.access)) {
        throw new Error(`ComputeBindingSet: storage texture "${decl.name}" was not validated for ${data.access} access.`);
    }
    return { _state: resource };
}

function getStorageTexture(engine: EngineContext, state: unknown): GPUBindingResource {
    const resource = state as ComputeStorageTexture;
    if (resource._engine !== engine || resource._destroyed || !_hasComputeStorageTexture(engine, resource)) {
        throw new Error("ComputeBindingSet contains an invalid storage texture resource.");
    }
    return resource._view;
}

/** Declare a write-only 2D storage texture and opt into storage-texture support. */
export function computeStorageTextureBinding(name: string, options: ComputeStorageTextureBindingOptions): ComputeBindingDecl {
    if (!_isComputeStorageTextureFormat(options.format)) {
        throw new Error(`computeStorageTextureBinding: format "${options.format}" is not supported.`);
    }
    return _computeStorageTextureViewBinding(name, { ...options, access: "write-only", viewDimension: "2d" });
}

/** @internal Create a storage-texture declaration for an explicit access and view dimension. */
export function _computeStorageTextureViewBinding(
    name: string,
    options: {
        readonly group: number;
        readonly binding: number;
        readonly format: GPUTextureFormat;
        readonly access: GPUStorageTextureAccess;
        readonly viewDimension: ComputeStorageTextureViewDimension;
    }
): ComputeBindingDecl {
    _installComputeBindingResolver(STORAGE_TEXTURE_KIND, resolveStorageTexture, getStorageTexture);
    return _createComputeBindingDecl(
        name,
        options.group,
        options.binding,
        STORAGE_TEXTURE_KIND,
        { storageTexture: { access: options.access, format: options.format, viewDimension: options.viewDimension } },
        { format: options.format, access: options.access, viewDimension: options.viewDimension } satisfies StorageTextureBindingData
    );
}
