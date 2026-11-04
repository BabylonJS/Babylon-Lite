import type { EngineContext } from "../engine/engine.js";
import { _createComputeBindingDecl, _installComputeBindingResolver, type ComputeBindingDecl } from "./compute-binding.js";
import type { ComputeTextureResource, ComputeTextureSampleType } from "./compute-texture-resource.js";
import { _isComputeTextureSampleTypeCompatible, _validateComputeTextureResource } from "./compute-texture-resource.js";

const TEXTURE_KIND = 3;

/** Options for a sampled 2D texture declaration. */
export interface ComputeTextureBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly sampleType?: ComputeTextureSampleType;
    readonly multisampled?: boolean;
}

interface TextureBindingData {
    readonly sampleType: ComputeTextureSampleType;
    readonly multisampled: boolean;
    readonly viewDimension: GPUTextureViewDimension;
}

function resolveTexture(engine: EngineContext, decl: ComputeBindingDecl, input: unknown) {
    const resource = input as ComputeTextureResource;
    const data = decl._data as TextureBindingData;
    if (resource) {
        _validateComputeTextureResource(resource);
    }
    if (!resource || resource._engine !== engine || !resource.texture?.view || resource._destroyed) {
        throw new Error(`ComputeBindingSet: texture resource for "${decl.name}" is invalid or belongs to a different engine.`);
    }
    if (!_isComputeTextureSampleTypeCompatible(resource.sampleType, data.sampleType)) {
        throw new Error(`ComputeBindingSet: texture "${decl.name}" has sample type ${resource.sampleType}, expected ${data.sampleType}.`);
    }
    if (resource.multisampled !== data.multisampled) {
        throw new Error(`ComputeBindingSet: texture "${decl.name}" multisampling does not match its declaration.`);
    }
    if (resource.viewDimension !== data.viewDimension) {
        throw new Error(`ComputeBindingSet: texture "${decl.name}" uses a ${resource.viewDimension} view, expected ${data.viewDimension}.`);
    }
    return { _state: resource };
}

function getTexture(engine: EngineContext, state: unknown): GPUBindingResource {
    const resource = state as ComputeTextureResource;
    _validateComputeTextureResource(resource);
    if (resource._engine !== engine || resource._destroyed) {
        throw new Error("ComputeBindingSet contains an invalid texture resource.");
    }
    return resource.texture.view;
}

/** Declare a sampled 2D texture binding and opt into texture support. */
export function computeTextureBinding(name: string, options: ComputeTextureBindingOptions): ComputeBindingDecl {
    return _computeTextureViewBinding(name, { ...options, viewDimension: "2d" });
}

/** @internal Create a sampled-texture declaration for an explicit view dimension. */
export function _computeTextureViewBinding(
    name: string,
    options: ComputeTextureBindingOptions & {
        readonly viewDimension: GPUTextureViewDimension;
    }
): ComputeBindingDecl {
    _installComputeBindingResolver(TEXTURE_KIND, resolveTexture, getTexture, (engine, state) => {
        const resource = state as ComputeTextureResource;
        if (resource._engine !== engine) {
            throw new Error("ComputeBindingSet contains a texture from a different engine.");
        }
        _validateComputeTextureResource(resource);
    });
    const multisampled = options.multisampled ?? false;
    const sampleType = options.sampleType ?? (multisampled ? "unfilterable-float" : "float");
    if (multisampled && sampleType === "float") {
        throw new Error("computeTextureBinding: multisampled float textures require sampleType unfilterable-float.");
    }
    return _createComputeBindingDecl(name, options.group, options.binding, TEXTURE_KIND, { texture: { sampleType, viewDimension: options.viewDimension, multisampled } }, {
        sampleType,
        multisampled,
        viewDimension: options.viewDimension,
    } satisfies TextureBindingData);
}
