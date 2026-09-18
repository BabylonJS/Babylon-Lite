import type { EngineContext } from "../engine/engine.js";
import { BU } from "../engine/gpu-flags.js";
import { createMappedBuffer } from "./mapped-buffer.js";

/** @internal Preserve the old device's limits only for the existing CPU-backed storage path. */
export function getCpuStorageRecoveryLimits(engine: EngineContext): Record<string, GPUSize64> | undefined {
    for (const buffer of engine._storageBuffers ?? []) {
        if (buffer._data) {
            const limits = engine._device.limits;
            return {
                maxBufferSize: limits.maxBufferSize,
                maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
                maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
            };
        }
    }
    return undefined;
}

/** @internal Existing CPU-backed storage restoration, kept behind the recovery runner. */
export function rebuildCpuStorageBuffers(engine: EngineContext): void {
    for (const buffer of engine._storageBuffers ?? []) {
        if (!buffer._destroyed && buffer._data) {
            buffer._buffer = createMappedBuffer(engine, buffer._data, BU.STORAGE, buffer._label);
        }
    }
}
