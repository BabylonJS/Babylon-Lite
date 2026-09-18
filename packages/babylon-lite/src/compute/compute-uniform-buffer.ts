import { BU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { align, createMappedBuffer } from "../resource/gpu-buffers.js";
import { registerManagedResourceDisposer } from "../resource/managed-resource-hooks.js";

declare const uniformBufferBrand: unique symbol;
let _buffers: WeakMap<EngineContext, Set<UniformBuffer>> | null = null;
let _hookedEngines: WeakSet<EngineContext> | null = null;

function buffersFor(engine: EngineContext): Set<UniformBuffer> {
    const buffers = (_buffers ??= new WeakMap());
    let set = buffers.get(engine);
    if (!set) {
        set = new Set();
        buffers.set(engine, set);
    }
    return set;
}

/** A GPU uniform allocation exposed without leaking its WebGPU handle. */
export interface UniformBuffer {
    /** Opaque nominal brand. */
    readonly [uniformBufferBrand]: true;
    /** Writable capacity in bytes, padded to 16 bytes. */
    readonly byteLength: number;
    /** @internal */
    _buffer: GPUBuffer | null;
    /** @internal */
    _destroyed: boolean;
    /** @internal CPU staging bytes used for partial updates and uniform arenas. */
    _data: Uint8Array | null;
    /** @internal */
    readonly _engine: EngineContext;
}

/** Options for {@link createUniformBuffer}. */
export interface UniformBufferOptions {
    readonly label?: string;
}

/** Create a CPU-authored uniform allocation with stable wrapper identity.
 *  Requested and padded sizes must be safe integers within the device's maxBufferSize;
 *  validation precedes allocation of the CPU shadow. */
export function createUniformBuffer(engine: EngineContext, source: ArrayBufferView | number, options?: UniformBufferOptions): UniformBuffer {
    const requested = typeof source === "number" ? source : source.byteLength;
    if (!Number.isSafeInteger(requested) || requested < 0) {
        throw new Error(`createUniformBuffer: byte length must be a non-negative safe integer, received ${requested}.`);
    }
    const byteLength = align(Math.max(requested, 16), 16);
    const maxBufferSize = engine._device.limits.maxBufferSize;
    if (!Number.isSafeInteger(byteLength) || byteLength > maxBufferSize) {
        throw new Error(`createUniformBuffer: aligned byte length ${byteLength} must be a safe integer within device maxBufferSize (${maxBufferSize}).`);
    }
    const bytes = new Uint8Array(byteLength);
    if (typeof source !== "number") {
        bytes.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
    }
    const buffer = { byteLength } as UniformBuffer;
    Object.defineProperties(buffer, {
        _buffer: { value: createMappedBuffer(engine, bytes, BU.UNIFORM, options?.label), writable: true },
        _destroyed: { value: false, writable: true },
        _data: { value: bytes, writable: true },
        _engine: { value: engine },
    });
    buffersFor(engine).add(buffer);
    const hooked = (_hookedEngines ??= new WeakSet());
    if (!hooked.has(engine)) {
        hooked.add(engine);
        registerManagedResourceDisposer(engine, () => _disposeUniformBuffers(engine));
    }
    return buffer;
}

/** @internal Resolve a live handle while building a bind group. */
export function _getUniformBufferHandle(engine: EngineContext, buffer: UniformBuffer): GPUBuffer {
    if (buffer._destroyed || !buffer._buffer || !buffer._data) {
        throw new Error("UniformBuffer has been disposed.");
    }
    if (buffer._engine !== engine) {
        throw new Error("UniformBuffer belongs to a different engine.");
    }
    if (!_buffers?.get(engine)?.has(buffer)) {
        throw new Error("UniformBuffer is not a live registered allocation.");
    }
    return buffer._buffer;
}

/** Replace an aligned byte range without changing binding identity. */
export function updateUniformBuffer(engine: EngineContext, buffer: UniformBuffer, data: ArrayBufferView, byteOffset = 0): void {
    _getUniformBufferHandle(engine, buffer);
    if (!Number.isInteger(byteOffset) || byteOffset < 0 || (byteOffset & 3) !== 0) {
        throw new Error("UniformBuffer byteOffset must be a non-negative multiple of 4.");
    }
    if ((data.byteLength & 3) !== 0) {
        throw new Error("UniformBuffer update data must have a byte length that is a multiple of 4.");
    }
    if (byteOffset + data.byteLength > buffer.byteLength) {
        throw new Error(`UniformBuffer update exceeds its ${buffer.byteLength}-byte capacity.`);
    }
    if (data.byteLength === 0) {
        return;
    }
    engine._device.queue.writeBuffer(buffer._buffer!, byteOffset, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    buffer._data!.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), byteOffset);
}

/** Destroy a uniform allocation. Repeated disposal is a no-op. */
export function disposeUniformBuffer(buffer: UniformBuffer): void {
    if (buffer._destroyed) {
        return;
    }
    const buffers = "_engine" in buffer ? _buffers?.get(buffer._engine) : undefined;
    if (!buffers?.has(buffer)) {
        throw new Error("UniformBuffer is not a live registered allocation.");
    }
    buffer._buffer?.destroy();
    buffer._buffer = null;
    buffer._data = null;
    buffer._destroyed = true;
    buffers.delete(buffer);
    buffer._engine._resourceEpoch = ((buffer._engine._resourceEpoch ?? 0) + 1) | 0;
    if (buffers.size === 0) {
        _buffers?.delete(buffer._engine);
    }
}

/** @internal Dispose every live uniform allocation before engine teardown. */
export function _disposeUniformBuffers(engine: EngineContext): void {
    for (const buffer of [...(_buffers?.get(engine) ?? [])]) {
        disposeUniformBuffer(buffer);
    }
}

/** @internal Test whether a uniform allocation remains registered with an engine. */
export function _hasUniformBuffer(engine: EngineContext, buffer: UniformBuffer): boolean {
    return _buffers?.get(engine)?.has(buffer) === true;
}
