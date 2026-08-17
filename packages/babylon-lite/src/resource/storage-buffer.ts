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
    /** @internal Bound as `var<storage, read_write>` and usable as a compute target. */
    readonly _writable?: boolean;
    /** @internal Carries `GPUBufferUsage.VERTEX`, so a mesh can source geometry from it. */
    readonly _vertex?: boolean;
    /** @internal Carries `GPUBufferUsage.INDEX`, so many meshes can share one topology. */
    readonly _index?: boolean;
}

/** Options for {@link createStorageBuffer}. */
export interface StorageBufferOptions {
    readonly label?: string;
    /** Bind as `var<storage, read_write>` so shaders — including compute — can write it.
     *
     *  A writable allocation keeps NO CPU shadow copy: its contents are produced on the
     *  GPU, so there is nothing meaningful to mirror, and shadowing a large slab would
     *  double its memory. The consequence is that it cannot be rebuilt automatically
     *  after device loss — `_rebuildStorageBuffers` reallocates it EMPTY and the owner
     *  must refill it (see `enableDeviceLostSceneRecovery` for the established pattern). */
    readonly writable?: boolean;
    /** Also mark the allocation `GPUBufferUsage.VERTEX` so a mesh can draw straight from
     *  it — letting a compute pass produce geometry with no readback and no copy. */
    readonly vertex?: boolean;
    /** Also mark the allocation `GPUBufferUsage.INDEX` so meshes can SHARE one topology.
     *
     *  `createMeshFromStorageBuffer` uploads a fresh index buffer per mesh when given a
     *  typed array, which is right for meshes with their own topology and wrong for a
     *  slab of uniform slots: every slot in such a slab has byte-identical indices, so
     *  a few thousand of them duplicate the same kilobytes a few thousand times. Pass
     *  one `index: true` allocation to every mesh instead and the topology is uploaded
     *  once. The allocation outlives the meshes and is the caller's to dispose. */
    readonly index?: boolean;
}

/** Create a shader storage buffer.
 *
 *  `source` is either the initial contents or a byte length for an uninitialized
 *  allocation (the usual choice for a compute target, which is written before it is read).
 *  Defaults to a read-only, CPU-initialized buffer — pass `writable`/`vertex` to opt in. */
export function createStorageBuffer(engine: EngineContext, source: ArrayBufferView | number, labelOrOptions?: string | StorageBufferOptions): StorageBuffer {
    const options: StorageBufferOptions = typeof labelOrOptions === "string" || labelOrOptions === undefined ? { label: labelOrOptions } : labelOrOptions;
    const { label, writable = false, vertex = false, index = false } = options;

    const requested = typeof source === "number" ? source : source.byteLength;
    const byteLength = align(Math.max(requested, 4), 4);
    // COPY_SRC on writable allocations keeps GPU-produced contents copyable — needed
    // for debugging, capture tooling, and staging into other resources. A compute
    // target you can never read out of is impractical to diagnose.
    const usage = BU.STORAGE | (vertex ? BU.VERTEX : 0) | (index ? BU.INDEX : 0) | (writable ? BU.COPY_SRC : 0);

    // A writable buffer keeps no CPU shadow: the GPU owns its contents.
    const bytes = writable ? null : new Uint8Array(byteLength);
    if (bytes && typeof source !== "number") {
        bytes.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
    }

    const buffer = bytes ? createMappedBuffer(engine, bytes, usage, label) : engine._device.createBuffer({ label, size: byteLength, usage: usage | BU.COPY_DST });
    if (writable && typeof source !== "number") {
        // Seed an explicitly-provided initial state even though we keep no shadow.
        engine._device.queue.writeBuffer(buffer, 0, source.buffer as ArrayBuffer, source.byteOffset, source.byteLength);
    }

    const storage = { byteLength } as StorageBuffer;
    Object.defineProperties(storage, {
        _buffer: { value: buffer, writable: true },
        _destroyed: { value: false, writable: true },
        _data: { value: bytes, writable: true },
        _engine: { value: engine },
        _label: { value: label },
        _writable: { value: writable },
        _vertex: { value: vertex },
        _index: { value: index },
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
    // A writable allocation intentionally has no `_data` shadow, so liveness is
    // decided by `_buffer` rather than by the mirror.
    if (buffer._destroyed || !buffer._buffer) {
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
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    // Writable allocations keep no shadow — the GPU copy is authoritative.
    buffer._data?.set(bytes, byteOffset);
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
        if (buffer._destroyed) {
            continue;
        }
        const usage = BU.STORAGE | (buffer._vertex ? BU.VERTEX : 0);
        if (buffer._data) {
            buffer._buffer = createMappedBuffer(engine, buffer._data, usage, buffer._label);
        } else {
            // Writable/compute-produced: no shadow to restore from. Reallocate at the
            // same size and leave it EMPTY — the owner refills it after device loss.
            buffer._buffer = engine._device.createBuffer({ label: buffer._label, size: buffer.byteLength, usage: usage | BU.COPY_DST });
        }
    }
}

/** @internal Dispose all live storage allocations before their engine device is destroyed. */
export function _disposeStorageBuffers(engine: EngineContext): void {
    for (const buffer of [...(engine._storageBuffers ?? [])]) {
        disposeStorageBuffer(buffer);
    }
}
