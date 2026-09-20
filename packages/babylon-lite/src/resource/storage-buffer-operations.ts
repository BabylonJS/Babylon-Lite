import type { EngineContext } from "../engine/engine.js";
import { addFramePostSubmitHook } from "../engine/frame-post-submit.js";
import { BU } from "../engine/gpu-flags.js";
import { _getStorageBufferHandle, readStorageBuffer, type StorageBuffer } from "./storage-buffer.js";

function validateRange(buffer: StorageBuffer, byteOffset: number, byteLength: number, operation: string): void {
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteOffset + byteLength > buffer.byteLength) {
        throw new RangeError(`${operation} range [${byteOffset}, ${byteOffset + byteLength}) exceeds the ${buffer.byteLength}-byte buffer.`);
    }
}

/** Clear an aligned storage-buffer range on the GPU. */
export function clearStorageBuffer(engine: EngineContext, buffer: StorageBuffer, byteOffset = 0, byteLength = buffer.byteLength - byteOffset): void {
    validateRange(buffer, byteOffset, byteLength, "clearStorageBuffer");
    if ((byteOffset & 3) !== 0 || (byteLength & 3) !== 0) {
        throw new RangeError("clearStorageBuffer byteOffset and byteLength must be multiples of 4.");
    }
    if (byteLength === 0) {
        return;
    }
    const handle = _getStorageBufferHandle(engine, buffer);
    if (engine._currentEncoder) {
        engine._currentEncoder.clearBuffer(handle, byteOffset, byteLength);
        return;
    }
    const encoder = engine._device.createCommandEncoder({ label: "storage-buffer-clear" });
    encoder.clearBuffer(handle, byteOffset, byteLength);
    engine._device.queue.submit([encoder.finish()]);
}

/** Write a storage-buffer range using Babylon.js/WebGPU alignment and zero-padding semantics. */
export function updateStorageBufferRange(engine: EngineContext, buffer: StorageBuffer, data: ArrayBufferView, byteOffset = 0): void {
    validateRange(buffer, byteOffset, data.byteLength, "updateStorageBufferRange");
    if (data.byteLength === 0) {
        return;
    }
    const handle = _getStorageBufferHandle(engine, buffer);
    const prefix = byteOffset & 3;
    const alignedOffset = byteOffset - prefix;
    const alignedLength = (data.byteLength + prefix + 3) & ~3;
    const sourceOffset = data.byteOffset - prefix;
    if (sourceOffset >= 0 && sourceOffset + alignedLength <= data.buffer.byteLength) {
        engine._device.queue.writeBuffer(handle, alignedOffset, data.buffer as ArrayBuffer, sourceOffset, alignedLength);
        return;
    }
    const padded = new Uint8Array(alignedLength);
    padded.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), prefix);
    engine._device.queue.writeBuffer(handle, alignedOffset, padded);
}

/** Read storage data after the active frame submits, or immediately when outside a frame. */
export function readStorageBufferAfterFrame(buffer: StorageBuffer, byteOffset = 0, byteLength = buffer.byteLength - byteOffset, noDelay = false): Promise<ArrayBuffer> {
    const engine = buffer._engine;
    if (!engine._currentEncoder) {
        return readStorageBuffer(buffer, byteOffset, byteLength);
    }
    if (noDelay) {
        return Promise.reject(new Error("Immediate storage-buffer readback cannot flush an active Babylon Lite frame."));
    }
    validateRange(buffer, byteOffset, byteLength, "readStorageBufferAfterFrame");
    if ((byteOffset & 3) !== 0 || (byteLength & 3) !== 0) {
        return Promise.reject(new RangeError("readStorageBufferAfterFrame byteOffset and byteLength must be multiples of 4."));
    }
    if (!buffer._writable) {
        return Promise.reject(new Error("readStorageBufferAfterFrame requires a writable StorageBuffer created with COPY_SRC usage."));
    }
    if (byteLength === 0) {
        return Promise.resolve(new ArrayBuffer(0));
    }
    const source = _getStorageBufferHandle(engine, buffer);
    const staging = engine._device.createBuffer({
        label: buffer._label ? `${buffer._label}-frame-readback` : "storage-frame-readback",
        size: byteLength,
        usage: BU.COPY_DST | BU.MAP_READ,
    });
    engine._currentEncoder.copyBufferToBuffer(source, byteOffset, staging, 0, byteLength);
    return new Promise<ArrayBuffer>((resolve, reject) => {
        const remove = addFramePostSubmitHook(engine, () => {
            remove();
            staging
                .mapAsync(GPUMapMode.READ, 0, byteLength)
                .then(() => staging.getMappedRange(0, byteLength).slice(0))
                .then(resolve, reject)
                .finally(() => {
                    staging.unmap();
                    staging.destroy();
                });
        });
    });
}
