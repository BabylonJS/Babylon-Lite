import type { EngineContext } from "../engine/engine.js";
import { _isTextureReleased } from "../resource/gpu-pool.js";
import type { Texture2D } from "../texture/texture-2d.js";

declare const computeTextureResourceBrand: unique symbol;

/** Sample type declared for a 2D texture binding. */
export type ComputeTextureSampleType = "float" | "unfilterable-float" | "depth" | "sint" | "uint";

/** Validated sampled 2D texture resource for compute bindings. */
export interface ComputeTextureResource {
    readonly [computeTextureResourceBrand]: true;
    readonly texture: Texture2D;
    readonly sampleType: ComputeTextureSampleType;
    readonly multisampled: boolean;
    readonly viewDimension: GPUTextureViewDimension;
    /** @internal */
    readonly _engine: EngineContext;
    /** @internal */
    _handle: GPUTexture;
    /** @internal */
    _destroyed: boolean;
}

/** Options for adapting a Texture2D to compute binding validation. */
export interface ComputeTextureResourceOptions {
    readonly sampleType?: ComputeTextureSampleType;
}

/** @internal Infer the WebGPU sample type from a texture's actual format. */
export function _inferComputeTextureSampleType(engine: EngineContext, texture: Texture2D): ComputeTextureSampleType {
    if (texture._sampleType === "depth") {
        return "depth";
    }
    return _inferComputeTextureFormatSampleType(engine, texture.texture.format);
}

/** @internal Resolve sample capability before a texture allocation exists. */
export function _inferComputeTextureFormatSampleType(engine: EngineContext, format: GPUTextureFormat): ComputeTextureSampleType {
    if (format.includes("stencil")) {
        throw new Error("createComputeTextureResource: stencil texture views are not currently supported.");
    }
    if (format.startsWith("depth")) {
        return "depth";
    }
    if (format === "r32float" || format === "rg32float" || format === "rgba32float") {
        return engine._device.features.has("float32-filterable") ? "float" : "unfilterable-float";
    }
    if (format.endsWith("uint")) {
        return "uint";
    }
    if (format.endsWith("sint")) {
        return "sint";
    }
    return "float";
}

/** @internal A filterable resource may be used through a non-filtering texture declaration. */
export function _isComputeTextureSampleTypeCompatible(actual: ComputeTextureSampleType, declared: ComputeTextureSampleType): boolean {
    return actual === declared || (actual === "float" && declared === "unfilterable-float");
}

/** @internal Create an adapter for a texture allocated by a compute-owned factory. */
export function _createOwnedComputeTextureResource(
    engine: EngineContext,
    texture: Texture2D,
    sampleType: ComputeTextureSampleType,
    viewDimension: GPUTextureViewDimension = "2d"
): ComputeTextureResource {
    return {
        texture,
        sampleType,
        multisampled: texture.texture.sampleCount > 1,
        viewDimension,
        _engine: engine,
        _handle: texture.texture,
        _destroyed: false,
    } as unknown as ComputeTextureResource;
}

/** Adapt and validate an existing 2D texture against the shader's GPU device. */
export async function createComputeTextureResource(engine: EngineContext, texture: Texture2D, options?: ComputeTextureResourceOptions): Promise<ComputeTextureResource> {
    if ("layers" in texture || "depth" in texture) {
        throw new Error("createComputeTextureResource: only 2D texture views are currently supported.");
    }
    return _createComputeTextureViewResource(engine, texture, {
        viewDimension: "2d",
        sampleType: options?.sampleType,
    });
}

/** @internal Validate and adapt an arbitrary texture view dimension. */
export async function _createComputeTextureViewResource(
    engine: EngineContext,
    texture: Texture2D,
    options: {
        readonly viewDimension: GPUTextureViewDimension;
        readonly sampleType?: ComputeTextureSampleType;
        readonly multisampled?: boolean;
    }
): Promise<ComputeTextureResource> {
    const inferredSampleType = _inferComputeTextureSampleType(engine, texture);
    const sampleType = options?.sampleType ?? inferredSampleType;
    if (!_isComputeTextureSampleTypeCompatible(inferredSampleType, sampleType)) {
        throw new Error(`createComputeTextureResource: declared sample type ${sampleType} is incompatible with texture format ${texture.texture.format}.`);
    }
    const viewDimension = options.viewDimension;
    const multisampled = texture.texture.sampleCount > 1;
    if (options.multisampled !== undefined && options.multisampled !== multisampled) {
        throw new Error(`createComputeTextureViewResource: declared multisampled=${options.multisampled} does not match the texture.`);
    }
    if (multisampled && viewDimension !== "2d") {
        throw new Error(`createComputeTextureViewResource: multisampled textures require a 2d view, received ${viewDimension}.`);
    }

    const device = engine._device;
    device.pushErrorScope("validation");
    let error: GPUError | null;
    try {
        const layout = device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType, viewDimension, multisampled } }],
        });
        device.createBindGroup({ layout, entries: [{ binding: 0, resource: texture.view }] });
    } finally {
        error = await device.popErrorScope();
    }
    if (engine._device !== device) {
        throw new Error("createComputeTextureResource: engine device changed during validation; retry with the recovered texture.");
    }
    if (error) {
        throw new Error(`createComputeTextureResource: texture is incompatible with this engine: ${error.message}`);
    }
    return _createOwnedComputeTextureResource(engine, texture, sampleType, viewDimension);
}

/** @internal Refresh handle state and reject textures released through the public pool. */
export function _validateComputeTextureResource(resource: ComputeTextureResource): void {
    if (resource._handle !== resource.texture.texture) {
        resource._handle = resource.texture.texture;
        resource._destroyed = false;
    }
    if (_isTextureReleased(resource.texture)) {
        resource._destroyed = true;
    }
    if (resource._destroyed) {
        throw new Error("ComputeBindingSet contains an invalid texture resource.");
    }
}

/** Notify cached compute bindings after replacing a texture's GPU view on the same device. */
export function invalidateComputeTextureResource(resource: ComputeTextureResource): void {
    resource._handle = resource.texture.texture;
    resource._destroyed = false;
    resource._engine._resourceEpoch = ((resource._engine._resourceEpoch ?? 0) + 1) | 0;
}
