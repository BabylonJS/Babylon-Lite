import { BU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { align, createMappedBuffer } from "./gpu-buffers.js";

declare const storageBufferBrand: unique symbol;

/** A GPU storage allocation exposed without leaking its WebGPU handle. */
export interface StorageBuffer {
    /** Opaque nominal brand. */
    readonly [storageBufferBrand]: true;
    /** Writable capacity in bytes, padded to WebGPU's four-byte alignment. */
    readonly byteLength: number;
    /** @internal */
    _buffer: GPUBuffer | null;
    /** @internal */
    _destroyed: boolean;
    /** @internal */
    _data: Uint8Array | null;
    /** @internal */
    readonly _engine: EngineContext;
    /** @internal */
    readonly _label?: string;
}

/** Create a read-only shader storage buffer initialized from `data`. */
export function createStorageBuffer(engine: EngineContext, data: ArrayBufferView, label?: string): StorageBuffer {
    const byteLength = align(Math.max(data.byteLength, 4), 4);
    const bytes = new Uint8Array(byteLength);
    bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    const storage = { byteLength } as StorageBuffer;
    Object.defineProperties(storage, {
        _buffer: { value: createMappedBuffer(engine, bytes, BU.STORAGE, label), writable: true },
        _destroyed: { value: false, writable: true },
        _data: { value: bytes, writable: true },
        _engine: { value: engine },
        _label: { value: label },
    });
    (engine._storageBuffers ??= new Set()).add(storage);
    if (!engine._storageRequiredLimits) {
        const limits = engine._device.limits;
        if (limits) {
            engine._storageRequiredLimits = {
                maxBufferSize: limits.maxBufferSize,
                maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
                maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
            };
        }
    }
    engine._rebuildStorageBuffers ??= () => _rebuildStorageBuffers(engine);
    engine._disposeStorageBuffers ??= () => _disposeStorageBuffers(engine);
    return storage;
}

/** @internal Resolve a live handle for one engine while building a bind group. */
export function _getStorageBufferHandle(engine: EngineContext, buffer: StorageBuffer): GPUBuffer {
    if (buffer._destroyed || !buffer._data) {
        throw new Error("StorageBuffer has been disposed.");
    }
    if (buffer._engine !== engine) {
        throw new Error("StorageBuffer belongs to a different engine.");
    }
    if (!engine._storageBuffers?.has(buffer)) {
        throw new Error("StorageBuffer is not a live registered allocation.");
    }
    return buffer._buffer!;
}

/** Replace a byte range without changing the storage buffer's binding identity. */
export function updateStorageBuffer(engine: EngineContext, buffer: StorageBuffer, data: ArrayBufferView, byteOffset = 0): void {
    if (buffer._destroyed) {
        throw new Error("StorageBuffer has been disposed.");
    }
    if (!("_engine" in buffer)) {
        throw new Error("StorageBuffer is not a live registered allocation.");
    }
    if (buffer._engine !== engine) {
        throw new Error("StorageBuffer belongs to a different engine.");
    }
    if (!engine._storageBuffers?.has(buffer)) {
        throw new Error("StorageBuffer is not a live registered allocation.");
    }
    if (!Number.isInteger(byteOffset) || byteOffset < 0 || (byteOffset & 3) !== 0) {
        throw new Error("StorageBuffer byteOffset must be a non-negative multiple of 4.");
    }
    if ((data.byteLength & 3) !== 0) {
        throw new Error("StorageBuffer update data must have a byte length that is a multiple of 4.");
    }
    if (byteOffset + data.byteLength > buffer.byteLength) {
        throw new Error(`StorageBuffer update exceeds its ${buffer.byteLength}-byte capacity.`);
    }
    if (data.byteLength === 0) {
        return;
    }
    engine._device.queue.writeBuffer(buffer._buffer!, byteOffset, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    buffer._data!.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), byteOffset);
}

/** Destroy a storage buffer. Repeated disposal is a no-op. */
export function disposeStorageBuffer(buffer: StorageBuffer): void {
    if (buffer._destroyed) {
        return;
    }
    if (!("_engine" in buffer) || !buffer._engine._storageBuffers?.has(buffer)) {
        throw new Error("StorageBuffer is not a live registered allocation.");
    }
    buffer._buffer?.destroy();
    buffer._buffer = null;
    buffer._engine._storageBuffers.delete(buffer);
    buffer._data = null;
    buffer._destroyed = true;
    if (buffer._engine._storageBuffers.size === 0) {
        buffer._engine._storageBuffers = undefined;
        buffer._engine._storageRequiredLimits = undefined;
        buffer._engine._rebuildStorageBuffers = undefined;
        buffer._engine._disposeStorageBuffers = undefined;
    }
}

/** @internal Rebuild every live storage allocation after the engine device changes. */
export function _rebuildStorageBuffers(engine: EngineContext): void {
    for (const buffer of engine._storageBuffers ?? []) {
        if (!buffer._destroyed && buffer._data) {
            buffer._buffer = createMappedBuffer(engine, buffer._data, BU.STORAGE, buffer._label);
        }
    }
}

/** @internal Dispose all live storage allocations before their engine device is destroyed. */
export function _disposeStorageBuffers(engine: EngineContext): void {
    for (const buffer of [...(engine._storageBuffers ?? [])]) {
        disposeStorageBuffer(buffer);
    }
}
