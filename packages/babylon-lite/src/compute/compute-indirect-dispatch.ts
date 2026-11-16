import { BU } from "../engine/gpu-flags.js";
import type { StorageBuffer } from "../resource/storage-buffer.js";
import { _getStorageBufferHandle } from "../resource/storage-buffer.js";
import type { ComputeBindingSet } from "./compute-bindings.js";
import { _createComputeDispatch, type ComputeDispatch } from "./compute-dispatch.js";
import type { ComputeShader } from "./compute-shader.js";
import { _assertComputeShaderLive } from "./compute-shader.js";

/** Options for an indirect dispatch whose workgroup dimensions live on the GPU. */
export interface ComputeIndirectDispatchOptions {
    readonly buffer: StorageBuffer;
    readonly byteOffset?: number;
    readonly enabled?: boolean;
}

function validate(shader: ComputeShader, buffer: StorageBuffer, byteOffset: number): void {
    _getStorageBufferHandle(shader._engine, buffer);
    if ((buffer._usage & BU.INDIRECT) === 0) {
        throw new Error("ComputeDispatch: indirect buffer must be created with { indirect: true }.");
    }
    if (!Number.isInteger(byteOffset) || byteOffset < 0 || (byteOffset & 3) !== 0) {
        throw new Error("ComputeDispatch: indirect byteOffset must be a non-negative multiple of 4.");
    }
    if (byteOffset + 12 > buffer.byteLength) {
        throw new Error(`ComputeDispatch: indirect arguments at ${byteOffset} exceed the buffer's ${buffer.byteLength}-byte capacity.`);
    }
}

function recordIndirect(pass: GPUComputePassEncoder, dispatch: ComputeDispatch): void {
    pass.dispatchWorkgroupsIndirect(_getStorageBufferHandle(dispatch.shader._engine, dispatch._indirectBuffer!), dispatch._indirectOffset!);
}

function setIndirect(dispatch: ComputeDispatch, buffer: StorageBuffer, byteOffset: number): void {
    dispatch._indirectBuffer = buffer;
    dispatch._indirectOffset = byteOffset;
    dispatch._record = recordIndirect;
}

/** Create an opt-in indirect dispatch. */
export function createComputeIndirectDispatch(shader: ComputeShader, bindings: ComputeBindingSet, options: ComputeIndirectDispatchOptions): ComputeDispatch {
    const byteOffset = options.byteOffset ?? 0;
    validate(shader, options.buffer, byteOffset);
    const dispatch = _createComputeDispatch(shader, bindings, options.enabled);
    setIndirect(dispatch, options.buffer, byteOffset);
    return dispatch;
}

/** Replace the GPU argument source of an indirect dispatch. */
export function setComputeIndirectDispatch(dispatch: ComputeDispatch, buffer: StorageBuffer, byteOffset = 0): void {
    _assertComputeShaderLive(dispatch.shader);
    validate(dispatch.shader, buffer, byteOffset);
    setIndirect(dispatch, buffer, byteOffset);
}
