import type { EngineContext } from "../engine/engine.js";
import { BU } from "../engine/gpu-flags.js";
import { _refreshStorageMeshes } from "../mesh/mesh-from-storage.js";
import { createMappedBuffer } from "./mapped-buffer.js";

/** @internal Read immutable limits from the old device only when live storage needs recovery. */
export function _getStorageRequiredLimits(engine: EngineContext): Record<string, GPUSize64> | undefined {
    if (!engine._storageBuffers?.size) {
        return undefined;
    }
    const limits = engine._device.limits;
    return {
        maxBufferSize: limits.maxBufferSize,
        maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
        maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
    };
}

/** @internal Rebuild allocations before refreshing the geometry that borrows their handles. */
export function _rebuildStorageBuffers(engine: EngineContext): void {
    for (const buffer of engine._storageBuffers ?? []) {
        if (buffer._destroyed) {
            continue;
        }
        buffer._buffer = buffer._data
            ? createMappedBuffer(engine, buffer._data, buffer._usage, buffer._label)
            : engine._device.createBuffer({ label: buffer._label, size: buffer.byteLength, usage: buffer._usage | BU.COPY_DST });
    }
    _refreshStorageMeshes(engine);
}
