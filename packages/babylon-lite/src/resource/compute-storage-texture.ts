import { TU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { acquireTexture, releaseTexture, _textureOwners } from "./gpu-pool.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { cloneTexture2D } from "../texture/texture-2d.js";
import type { ComputeTextureResource } from "../compute/compute-texture-resource.js";
import { _createOwnedComputeTextureResource, _inferComputeTextureFormatSampleType } from "../compute/compute-texture-resource.js";
import type { ComputeSampler } from "../compute/compute-sampler-resource.js";
import { createComputeSampler, _inferComputeSamplerType } from "../compute/compute-sampler-resource.js";
import { registerManagedResourceDisposer } from "./managed-resource-hooks.js";
import { _supportsComputeRenderMipmaps } from "./compute-storage-mip-support.js";

declare const computeStorageTextureBrand: unique symbol;
let _resources: WeakMap<EngineContext, Set<ComputeStorageTexture>> | null = null;
let _hookedEngines: WeakSet<EngineContext> | null = null;

function resourcesFor(engine: EngineContext): Set<ComputeStorageTexture> {
    const resources = (_resources ??= new WeakMap());
    let set = resources.get(engine);
    if (!set) {
        set = new Set();
        resources.set(engine, set);
    }
    return set;
}

/** Storage texture with stable identity until explicit or engine disposal. */
export interface ComputeStorageTexture {
    readonly [computeStorageTextureBrand]: true;
    readonly width: number;
    readonly height: number;
    readonly depthOrArrayLayers: number;
    readonly viewDimension: ComputeStorageTextureViewDimension;
    readonly format: GPUTextureFormat;
    readonly accesses: readonly GPUStorageTextureAccess[];
    readonly sampledTexture: Texture2D | null;
    readonly computeTexture: ComputeTextureResource | null;
    readonly computeSampler: ComputeSampler | null;
    /** @internal */
    readonly _engine: EngineContext;
    /** @internal */
    _texture: GPUTexture;
    /** @internal */
    _view: GPUTextureView;
    /** @internal */
    _destroyed: boolean;
}

/** Compact write-only, sampled 2D storage texture. */
export interface ComputeStorageTexture2D extends ComputeStorageTexture {
    readonly viewDimension: "2d";
    readonly format: ComputeStorageTextureFormat;
    readonly sampledTexture: Texture2D;
    readonly computeTexture: ComputeTextureResource;
    readonly computeSampler: ComputeSampler;
}

/** Options for {@link createComputeStorageTexture2D}. */
export interface ComputeStorageTexture2DOptions {
    readonly width: number;
    readonly height: number;
    readonly format: "rgba8unorm" | "rgba8snorm" | "rgba16float" | "r32float" | "rgba32float";
    readonly label?: string;
    /** Material-side V flip for Y-up UVs. Default true. */
    readonly invertY?: boolean;
}

/** Storage formats implemented by the first compute texture surface. */
export type ComputeStorageTextureFormat = ComputeStorageTexture2DOptions["format"];
/** Storage texture view dimensions supported by WGSL. */
export type ComputeStorageTextureViewDimension = "1d" | "2d" | "2d-array" | "3d";

/** @internal Normalized options shared by compact and advanced factories. */
export interface ComputeStorageTextureInternalOptions {
    readonly width: number;
    readonly height: number;
    readonly depthOrArrayLayers: number;
    readonly viewDimension: ComputeStorageTextureViewDimension;
    readonly format: GPUTextureFormat;
    readonly accesses: readonly GPUStorageTextureAccess[];
    readonly sampled: boolean;
    readonly sampleType: ComputeTextureResource["sampleType"] | null;
    readonly sampler?: GPUSamplerDescriptor;
    readonly mipMaps?: boolean;
    readonly label?: string;
    readonly invertY?: boolean;
}

/** @internal Runtime validation for JavaScript callers and declaration helpers. */
export function _isComputeStorageTextureFormat(format: GPUTextureFormat): format is ComputeStorageTextureFormat {
    return format === "rgba8unorm" || format === "rgba8snorm" || format === "rgba16float" || format === "r32float" || format === "rgba32float";
}

/** @internal Resolve and validate the sampling pair once, before GPU allocation. */
export function _resolveComputeStorageTextureSampleType(engine: EngineContext, format: GPUTextureFormat, sampler?: GPUSamplerDescriptor): ComputeTextureResource["sampleType"] {
    if (typeof format !== "string") {
        throw new Error("ComputeStorageTexture: format must be a GPU texture format string.");
    }
    const sampleType = _inferComputeTextureFormatSampleType(engine, format);
    const samplerType = _inferComputeSamplerType(sampler);
    if ((samplerType === "filtering" && sampleType !== "float" && sampleType !== "depth") || (samplerType === "comparison" && sampleType !== "depth")) {
        throw new Error(`ComputeStorageTexture: ${format} (${sampleType}) is incompatible with a ${samplerType} sampler.`);
    }
    return sampleType;
}

function validateOptions(engine: EngineContext, options: ComputeStorageTexture2DOptions): void {
    const max = Number(engine._device.limits.maxTextureDimension2D) || Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(options.width) || options.width <= 0 || options.width > max || !Number.isInteger(options.height) || options.height <= 0 || options.height > max) {
        throw new Error(`ComputeStorageTexture2D: dimensions must be positive integers no larger than ${max}.`);
    }
    if (!_isComputeStorageTextureFormat(options.format)) {
        throw new Error(`ComputeStorageTexture2D: format "${options.format}" is not supported.`);
    }
}

interface ComputeStorageTextureGpuState {
    readonly texture: GPUTexture;
    readonly view: GPUTextureView;
    readonly sampling: {
        readonly sampleType: ComputeTextureResource["sampleType"];
        readonly view: GPUTextureView;
        readonly sampler: ComputeSampler;
    } | null;
}

/** @internal Allocate one GPU texture/view/sampler tuple from validated sampling options. */
export function _createComputeStorageTextureGpuState(engine: EngineContext, options: ComputeStorageTextureInternalOptions): ComputeStorageTextureGpuState {
    const dimension: GPUTextureDimension = options.viewDimension === "1d" ? "1d" : options.viewDimension === "3d" ? "3d" : "2d";
    const mipExtent =
        options.viewDimension === "1d"
            ? options.width
            : options.viewDimension === "3d"
              ? Math.max(options.width, options.height, options.depthOrArrayLayers)
              : Math.max(options.width, options.height);
    const mipLevelCount = options.mipMaps ? Math.floor(Math.log2(mipExtent)) + 1 : 1;
    const texture = engine._device.createTexture({
        label: options.label,
        size: { width: options.width, height: options.height, depthOrArrayLayers: options.depthOrArrayLayers },
        dimension,
        format: options.format,
        mipLevelCount,
        usage:
            TU.STORAGE_BINDING |
            TU.COPY_SRC |
            TU.COPY_DST |
            (options.sampled ? TU.TEXTURE_BINDING : 0) |
            (options.mipMaps && _supportsComputeRenderMipmaps(engine, options.viewDimension, options.format, options.sampled) ? TU.RENDER_ATTACHMENT : 0),
    });
    try {
        const view = texture.createView({ dimension: options.viewDimension, baseMipLevel: 0, mipLevelCount: 1 });
        let sampling: ComputeStorageTextureGpuState["sampling"] = null;
        if (options.sampled) {
            if (options.sampleType === null) {
                throw new Error("ComputeStorageTexture: sampled outputs require validated sample metadata.");
            }
            sampling = {
                sampleType: options.sampleType,
                view: options.mipMaps ? texture.createView({ dimension: options.viewDimension }) : view,
                sampler: createComputeSampler(engine, options.sampler),
            };
        }
        return { texture, view, sampling };
    } catch (error) {
        texture.destroy();
        throw error;
    }
}

/** @internal Build and register a resource from already validated GPU state. */
export function _createComputeStorageTexture(
    engine: EngineContext,
    options: ComputeStorageTextureInternalOptions,
    gpu = _createComputeStorageTextureGpuState(engine, options)
): ComputeStorageTexture {
    const sampling = gpu.sampling;
    const computeSampler = sampling?.sampler ?? null;
    let sampledTexture: Texture2D | null = null;
    let computeTexture: ComputeTextureResource | null = null;
    if (sampling) {
        sampledTexture = {
            texture: gpu.texture,
            view: sampling.view,
            sampler: sampling.sampler._sampler,
            width: options.width,
            height: options.height,
            invertY: options.invertY ?? true,
            ...(options.viewDimension === "2d-array" ? { layers: options.depthOrArrayLayers } : {}),
            ...(options.viewDimension === "3d" ? { depth: options.depthOrArrayLayers } : {}),
        };
        acquireTexture(sampledTexture);
        computeTexture = _createOwnedComputeTextureResource(engine, sampledTexture, sampling.sampleType, options.viewDimension);
    }
    const resource = {
        width: options.width,
        height: options.height,
        depthOrArrayLayers: options.depthOrArrayLayers,
        viewDimension: options.viewDimension,
        format: options.format,
        accesses: options.accesses,
        sampledTexture,
        computeTexture,
        computeSampler,
        _engine: engine,
        _texture: gpu.texture,
        _view: gpu.view,
        _destroyed: false,
    } as unknown as ComputeStorageTexture;
    resourcesFor(engine).add(resource);
    const hooked = (_hookedEngines ??= new WeakSet());
    if (!hooked.has(engine)) {
        hooked.add(engine);
        registerManagedResourceDisposer(engine, () => _disposeComputeStorageTextures(engine));
    }
    return resource;
}

/** Create an empty compute-writable texture with a stable sampled Texture2D facade. */
export function createComputeStorageTexture2D(engine: EngineContext, options: ComputeStorageTexture2DOptions): ComputeStorageTexture2D {
    validateOptions(engine, options);
    return _createComputeStorageTexture(
        engine,
        Object.freeze({
            width: options.width,
            height: options.height,
            depthOrArrayLayers: 1,
            viewDimension: "2d",
            format: options.format,
            accesses: Object.freeze(["write-only"] as GPUStorageTextureAccess[]),
            sampled: true,
            sampleType: _resolveComputeStorageTextureSampleType(engine, options.format),
            label: options.label,
            invertY: options.invertY,
        })
    ) as ComputeStorageTexture2D;
}

/** Clone the sampled facade while sharing the underlying storage texture. */
export function cloneComputeStorageTexture2D(
    resource: ComputeStorageTexture2D,
    transform: Partial<Pick<Texture2D, "uScale" | "vScale" | "uOffset" | "vOffset" | "uAng">>
): Texture2D {
    if (resource._destroyed) {
        throw new Error("ComputeStorageTexture2D has been disposed.");
    }
    return cloneTexture2D(resource.sampledTexture, transform);
}

/** Destroy a storage texture. Repeated disposal is a no-op. */
export function disposeComputeStorageTexture2D(resource: ComputeStorageTexture2D): void {
    disposeComputeStorageTexture(resource);
}

function disposeComputeStorageTextureInternal(resource: ComputeStorageTexture, force: boolean): void {
    if (resource._destroyed) {
        return;
    }
    const resources = _resources?.get(resource._engine);
    if (resources?.has(resource) !== true) {
        throw new Error("ComputeStorageTexture2D is not a live registered allocation.");
    }
    const owners = resource.sampledTexture ? _textureOwners(resource.sampledTexture) : 0;
    if (!force && owners > 1) {
        throw new Error("ComputeStorageTexture2D cannot be disposed while sampled facades are still owned.");
    }
    if (resource.sampledTexture) {
        const releases = force ? Math.max(owners, 1) : 1;
        for (let i = 0; i < releases; i++) {
            releaseTexture(resource.sampledTexture);
        }
    } else {
        resource._texture.destroy();
    }
    if (resource.computeTexture) {
        resource.computeTexture._destroyed = true;
    }
    resource._destroyed = true;
    resources.delete(resource);
    resource._engine._resourceEpoch = ((resource._engine._resourceEpoch ?? 0) + 1) | 0;
    if (resources.size === 0) {
        _resources?.delete(resource._engine);
    }
}

/** Dispose any dimension of compute storage texture. */
export function disposeComputeStorageTexture(resource: ComputeStorageTexture): void {
    disposeComputeStorageTextureInternal(resource, false);
}

/** @internal Dispose every live storage texture before engine teardown. */
export function _disposeComputeStorageTextures(engine: EngineContext): void {
    for (const resource of [...(_resources?.get(engine) ?? [])]) {
        disposeComputeStorageTextureInternal(resource, true);
    }
}

/** @internal Test whether a storage texture remains registered with an engine. */
export function _hasComputeStorageTexture(engine: EngineContext, resource: ComputeStorageTexture): boolean {
    return _resources?.get(engine)?.has(resource) === true;
}
