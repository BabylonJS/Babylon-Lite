import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { ComputeStorageTexture, ComputeStorageTextureInternalOptions, ComputeStorageTextureViewDimension } from "./compute-storage-texture.js";
import {
    _createComputeStorageTexture,
    _createComputeStorageTextureGpuState,
    _resolveComputeStorageTextureSampleType,
    disposeComputeStorageTexture as _disposeComputeStorageTexture,
} from "./compute-storage-texture.js";

/** Advanced storage texture dimensions, format, access, and sampling options. */
export interface ComputeStorageTextureOptions {
    readonly width: number;
    readonly height?: number;
    readonly depthOrArrayLayers?: number;
    readonly viewDimension: ComputeStorageTextureViewDimension;
    readonly format: GPUTextureFormat;
    readonly access?: GPUStorageTextureAccess | readonly GPUStorageTextureAccess[];
    readonly sampled?: boolean;
    readonly sampler?: GPUSamplerDescriptor;
    readonly mipMaps?: boolean;
    readonly label?: string;
    readonly invertY?: boolean;
}

function validatePositive(name: string, value: number, maximum: number): void {
    if (!Number.isInteger(value) || value <= 0 || value > maximum) {
        throw new Error(`ComputeStorageTexture: ${name} must be a positive integer no larger than ${maximum}, received ${value}.`);
    }
}

function normalizeOptions(engine: EngineContext, options: ComputeStorageTextureOptions): ComputeStorageTextureInternalOptions {
    const limits = engine._device.limits;
    const height = options.height ?? 1;
    const depthOrArrayLayers = options.depthOrArrayLayers ?? 1;
    const dimensionLimit =
        options.viewDimension === "1d"
            ? Number(limits.maxTextureDimension1D)
            : options.viewDimension === "3d"
              ? Number(limits.maxTextureDimension3D)
              : Number(limits.maxTextureDimension2D);
    validatePositive("width", options.width, dimensionLimit || Number.MAX_SAFE_INTEGER);
    validatePositive("height", height, (options.viewDimension === "3d" ? Number(limits.maxTextureDimension3D) : Number(limits.maxTextureDimension2D)) || Number.MAX_SAFE_INTEGER);
    validatePositive(
        "depthOrArrayLayers",
        depthOrArrayLayers,
        (options.viewDimension === "3d" ? Number(limits.maxTextureDimension3D) : Number(limits.maxTextureArrayLayers)) || Number.MAX_SAFE_INTEGER
    );
    if (options.viewDimension === "1d" && (height !== 1 || depthOrArrayLayers !== 1)) {
        throw new Error("ComputeStorageTexture: 1d textures require height=1 and depthOrArrayLayers=1.");
    }
    if (options.viewDimension === "1d" && options.mipMaps) {
        throw new Error("ComputeStorageTexture: mipMaps is not supported for 1d textures.");
    }
    if (options.viewDimension === "2d" && depthOrArrayLayers !== 1) {
        throw new Error("ComputeStorageTexture: 2d textures require depthOrArrayLayers=1; use 2d-array for layers.");
    }
    const requested = typeof options.access === "string" ? [options.access] : [...(options.access ?? ["write-only"])];
    const accesses: GPUStorageTextureAccess[] = [];
    for (const access of requested) {
        if (access !== "write-only" && access !== "read-only" && access !== "read-write") {
            throw new Error(`ComputeStorageTexture: unsupported access "${String(access)}".`);
        }
        if (!accesses.includes(access)) {
            accesses.push(access);
        }
    }
    if (accesses.length === 0) {
        throw new Error("ComputeStorageTexture: at least one access mode is required.");
    }
    const sampled = options.sampled ?? true;
    const sampler = sampled && options.sampler ? Object.freeze({ ...options.sampler }) : undefined;
    return Object.freeze({
        width: options.width,
        height,
        depthOrArrayLayers,
        viewDimension: options.viewDimension,
        format: options.format,
        accesses: Object.freeze(accesses),
        sampled,
        sampleType: sampled ? _resolveComputeStorageTextureSampleType(engine, options.format, sampler) : null,
        sampler,
        mipMaps: options.mipMaps,
        label: options.label,
        invertY: options.invertY,
    });
}

/** Create and validate an arbitrary-dimensional storage texture. */
export async function createComputeStorageTexture(engine: EngineContext, options: ComputeStorageTextureOptions): Promise<ComputeStorageTexture> {
    const normalized = normalizeOptions(engine, options);
    const device = engine._device;
    device.pushErrorScope("validation");
    let gpu: ReturnType<typeof _createComputeStorageTextureGpuState> | null = null;
    let creationError: unknown;
    let validationError: GPUError | null;
    try {
        gpu = _createComputeStorageTextureGpuState(engine, normalized);
        for (const access of normalized.accesses) {
            const layout = device.createBindGroupLayout({
                entries: [{ binding: 0, visibility: SS.COMPUTE, storageTexture: { access, format: normalized.format, viewDimension: normalized.viewDimension } }],
            });
            device.createBindGroup({ layout, entries: [{ binding: 0, resource: gpu.view }] });
        }
        if (gpu.sampling) {
            const sampling = gpu.sampling;
            const layout = device.createBindGroupLayout({
                entries: [
                    { binding: 0, visibility: SS.COMPUTE, texture: { sampleType: sampling.sampleType, viewDimension: normalized.viewDimension } },
                    { binding: 1, visibility: SS.COMPUTE, sampler: { type: sampling.sampler.type } },
                ],
            });
            device.createBindGroup({
                layout,
                entries: [
                    { binding: 0, resource: sampling.view },
                    { binding: 1, resource: sampling.sampler._sampler },
                ],
            });
        }
    } catch (error) {
        creationError = error;
    } finally {
        validationError = await device.popErrorScope();
    }
    if (creationError || !gpu) {
        gpu?.texture.destroy();
        throw new Error(`createComputeStorageTexture: invalid texture descriptor: ${creationError instanceof Error ? creationError.message : String(creationError)}`, {
            cause: creationError,
        });
    }
    if (engine._device !== device) {
        gpu.texture.destroy();
        throw new Error("createComputeStorageTexture: engine device changed during validation; recreate the resource on the current device.");
    }
    if (validationError) {
        gpu.texture.destroy();
        throw new Error(`createComputeStorageTexture: unsupported format, dimension, or access combination: ${validationError.message}`);
    }
    return _createComputeStorageTexture(engine, normalized, gpu);
}

/** Dispose an advanced storage texture. */
export function disposeComputeStorageTexture(resource: ComputeStorageTexture): void {
    _disposeComputeStorageTexture(resource);
}

export type { ComputeStorageTexture, ComputeStorageTextureViewDimension };
