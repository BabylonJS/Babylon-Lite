import type { ComputeBindingSet } from "./compute-bindings.js";
import type { ComputeShader } from "./compute-shader.js";
import { _assertComputeShaderLive } from "./compute-shader.js";
import type { StorageBuffer } from "../resource/storage-buffer.js";

/** Direct workgroup dimensions. Zero is a valid no-op. */
export interface ComputeDirectDispatch {
    readonly x: number;
    readonly y?: number;
    readonly z?: number;
}

/** Options for a direct reusable dispatch. */
export interface ComputeDispatchOptions {
    readonly size: ComputeDirectDispatch;
    readonly enabled?: boolean;
}

declare const computeDispatchBrand: unique symbol;

/** One reusable invocation of a compute shader with one immutable binding set. */
export interface ComputeDispatch {
    readonly [computeDispatchBrand]: true;
    readonly shader: ComputeShader;
    readonly bindings: ComputeBindingSet;
    enabled: boolean;
    /** @internal Retained arrays installed only by the dynamic-offset helper. */
    _dynamicOffsets?: number[][];
    /** @internal Optional pipeline-variant resolver. */
    _getPipeline?: () => GPUComputePipeline;
    /** @internal Optional pipeline-variant preparer. */
    _preparePipeline?: () => Promise<void>;
    /** @internal Optional non-direct recorder, installed by indirect dispatch support. */
    _record?: (pass: GPUComputePassEncoder, dispatch: ComputeDispatch) => void;
    /** @internal Indirect source installed only by the opt-in indirect module. */
    _indirectBuffer?: StorageBuffer;
    /** @internal */
    _indirectOffset?: number;
    /** @internal */
    _x: number;
    /** @internal */
    _y: number;
    /** @internal */
    _z: number;
}

function validateDimension(name: string, value: number, max: number, size: ComputeDirectDispatch): void {
    if (!Number.isInteger(value) || value < 0 || value > max) {
        throw new Error(`ComputeDispatch: ${name} workgroup dimension must be an integer in [0, ${max}], received ${size.x}x${size.y ?? 1}x${size.z ?? 1}.`);
    }
}

function setDirect(dispatch: ComputeDispatch, size: ComputeDirectDispatch): void {
    const max = Number(dispatch.shader._engine._device.limits.maxComputeWorkgroupsPerDimension) || Number.MAX_SAFE_INTEGER;
    const y = size.y ?? 1;
    const z = size.z ?? 1;
    validateDimension("x", size.x, max, size);
    validateDimension("y", y, max, size);
    validateDimension("z", z, max, size);
    dispatch._x = size.x;
    dispatch._y = y;
    dispatch._z = z;
}

/** @internal Create the shared dispatch state used by direct and opt-in variants. */
export function _createComputeDispatch(shader: ComputeShader, bindings: ComputeBindingSet, enabled = true): ComputeDispatch {
    _assertComputeShaderLive(shader);
    if (bindings.shader !== shader) {
        throw new Error("ComputeDispatch: binding set belongs to a different ComputeShader.");
    }
    return {
        shader,
        bindings,
        enabled,
        _x: 0,
        _y: 1,
        _z: 1,
    } as unknown as ComputeDispatch;
}

/** Create a reusable direct dispatch record. */
export function createComputeDispatch(shader: ComputeShader, bindings: ComputeBindingSet, options: ComputeDispatchOptions): ComputeDispatch {
    const dispatch = _createComputeDispatch(shader, bindings, options.enabled);
    setComputeDispatchSize(dispatch, options.size);
    return dispatch;
}

/** Replace direct workgroup dimensions. */
export function setComputeDispatchSize(dispatch: ComputeDispatch, size: ComputeDirectDispatch): void {
    _assertComputeShaderLive(dispatch.shader);
    setDirect(dispatch, size);
    dispatch._record = undefined;
}
