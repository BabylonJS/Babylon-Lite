import { BU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { align } from "./buffer-alignment.js";
import { createMappedBuffer } from "./mapped-buffer.js";

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
    /** @internal CPU shadow for plain read-only storage; absent for GPU-role allocations. */
    _data: Uint8Array | null;
    /** @internal */
    readonly _engine: EngineContext;
    /** @internal */
    readonly _label?: string;
    /** @internal Bound as `var<storage, read_write>` and usable as a compute target. */
    readonly _writable?: boolean;
    /** @internal Creation-time role flags used for capability checks and allocation.
     *  Every allocation additionally carries COPY_DST through its allocation path. */
    readonly _usage: GPUBufferUsageFlags;
    /** @internal Lazily allocated staging buffer for throttled diagnostics/readback. */
    _readback?: GPUBuffer;
    /** @internal Device that owns `_readback`. */
    _readbackDevice?: GPUDevice;
    /** @internal Allocated readback capacity. */
    _readbackSize?: number;
    /** @internal Coalesces identical read requests for this allocation. */
    _readPending?: Promise<ArrayBuffer>;
    /** @internal Source range for the pending read. */
    _readPendingOffset?: number;
    /** @internal */
    _readPendingLength?: number;
}

/** Options for {@link createStorageBuffer}.
 *  Writable/vertex/index/indirect allocations keep no CPU mirror and require recreation after device loss. */
export interface StorageBufferOptions {
    readonly label?: string;
    /** Bind as `var<storage, read_write>` so shaders — including compute — can write it.
     *
     *  A writable allocation keeps NO CPU shadow copy: its contents are produced on the
     *  GPU, so there is nothing meaningful to mirror, and shadowing a large slab would
     *  double its memory. Automatic recovery of writable allocations is deferred;
     *  recreate the allocation and its consumers after device loss. */
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
    /** Also mark the allocation `GPUBufferUsage.INDIRECT` so compute can produce
     *  workgroup counts or draw arguments without CPU readback. */
    readonly indirect?: boolean;
}

/** Create a shader storage buffer.
 *
 *  `source` is either the initial contents or a byte length for an uninitialized
 *  allocation (the usual choice for a compute target, which is written before it is read).
 *  Numeric sizes must be non-negative safe integers. Capacity is rounded up to four bytes
 *  (at least four, even for an empty source) and must fit the device's maxBufferSize.
 *  Defaults to a read-only, CPU-initialized buffer — pass `writable`/`vertex` to opt in. */
export function createStorageBuffer(engine: EngineContext, source: ArrayBufferView | number, labelOrOptions?: string | StorageBufferOptions): StorageBuffer {
    const options: StorageBufferOptions = typeof labelOrOptions === "string" || labelOrOptions === undefined ? { label: labelOrOptions } : labelOrOptions;
    const { label, writable = false, vertex = false, index = false, indirect = false } = options;

    const isByteLength = typeof source === "number";
    const requested = isByteLength ? source : source.byteLength;
    if (!Number.isSafeInteger(requested) || requested < 0) {
        throw new Error(`createStorageBuffer: byte length must be a non-negative safe integer; received ${requested}.`);
    }
    const byteLength = align(Math.max(requested, 4), 4);
    const maxBufferSize = engine._device.limits.maxBufferSize;
    if (!Number.isSafeInteger(byteLength) || byteLength > maxBufferSize) {
        throw new Error(`createStorageBuffer: aligned byte length ${byteLength} must be a safe integer within device maxBufferSize (${maxBufferSize}).`);
    }
    // COPY_SRC on writable allocations keeps GPU-produced contents copyable — needed
    // for debugging, capture tooling, and staging into other resources.
    const usage = BU.STORAGE | (vertex ? BU.VERTEX : 0) | (index ? BU.INDEX : 0) | (indirect ? BU.INDIRECT : 0) | (writable ? BU.COPY_SRC : 0);

    // Only the pre-existing plain read-only resource participates in CPU-backed recovery.
    const bytes = usage === BU.STORAGE ? new Uint8Array(byteLength) : null;
    if (bytes && !isByteLength) {
        bytes.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
    }

    const initialData = bytes ?? (isByteLength ? null : source);
    const buffer = initialData ? createMappedBuffer(engine, initialData, usage, label) : engine._device.createBuffer({ label, size: byteLength, usage: usage | BU.COPY_DST });

    const storage = { byteLength } as StorageBuffer;
    Object.defineProperties(storage, {
        _buffer: { value: buffer, writable: true },
        _destroyed: { value: false, writable: true },
        _data: { value: bytes, writable: true },
        _engine: { value: engine },
        _label: { value: label },
        _writable: { value: writable },
        _usage: { value: usage },
    });
    (engine._storageBuffers ??= new Set()).add(storage);
    engine._disposeStorageBuffers ??= () => _disposeStorageBuffers(engine);
    return storage;
}

/** @internal Resolve a live handle for one engine while building a bind group. */
export function _getStorageBufferHandle(engine: EngineContext, buffer: StorageBuffer): GPUBuffer {
    // GPU-role allocations intentionally have no `_data` shadow, so liveness is
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
    // GPU-role allocations keep no shadow — the GPU copy is authoritative.
    const shadow = buffer._data;
    if (shadow) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        shadow.set(bytes, byteOffset);
    }
}

/** Read an aligned range of a GPU-writable storage allocation through one lazily reused staging buffer.
 *  Call after the producing frame is submitted; an active frame encoder is rejected. */
export function readStorageBuffer(buffer: StorageBuffer): Promise<ArrayBuffer>;
export function readStorageBuffer(buffer: StorageBuffer, byteOffset: number, byteLength?: number): Promise<ArrayBuffer>;
export function readStorageBuffer(buffer: StorageBuffer, byteOffset = 0, byteLength = buffer.byteLength - byteOffset): Promise<ArrayBuffer> {
    if (buffer._destroyed || !buffer._buffer || !buffer._engine._storageBuffers?.has(buffer)) {
        return Promise.reject(new Error("StorageBuffer is not a live registered allocation."));
    }
    if (!buffer._writable) {
        return Promise.reject(new Error("readStorageBuffer requires a writable StorageBuffer created with COPY_SRC usage."));
    }
    if (buffer._engine._currentEncoder) {
        return Promise.reject(new Error("readStorageBuffer cannot run while a frame encoder is active; wait until the producing frame is submitted."));
    }
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || (byteOffset & 3) !== 0) {
        return Promise.reject(new Error("readStorageBuffer byteOffset must be a non-negative safe integer and multiple of 4."));
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || (byteLength & 3) !== 0) {
        return Promise.reject(new Error("readStorageBuffer byteLength must be a non-negative safe integer and multiple of 4."));
    }
    if (byteOffset + byteLength > buffer.byteLength) {
        return Promise.reject(new Error(`readStorageBuffer range exceeds the buffer's ${buffer.byteLength}-byte capacity.`));
    }
    if (byteLength === 0) {
        return Promise.resolve(new ArrayBuffer(0));
    }
    const device = buffer._engine._device;
    if (buffer._readPending) {
        if (buffer._readbackDevice !== device) {
            return Promise.reject(new Error("StorageBuffer device changed during a pending readback."));
        }
        if (buffer._readPendingOffset === byteOffset && buffer._readPendingLength === byteLength) {
            return buffer._readPending;
        }
        return buffer._readPending.then(
            () => readStorageBuffer(buffer, byteOffset, byteLength),
            () => readStorageBuffer(buffer, byteOffset, byteLength)
        );
    }
    if (buffer._readback && (buffer._readbackDevice !== device || (buffer._readbackSize ?? 0) < byteLength)) {
        buffer._readback.destroy();
        buffer._readback = undefined;
        buffer._readbackSize = undefined;
    }
    const staging = (buffer._readback ??= device.createBuffer({
        label: buffer._label ? `${buffer._label}-readback` : "storage-readback",
        size: byteLength,
        usage: BU.COPY_DST | BU.MAP_READ,
    }));
    buffer._readbackDevice = device;
    buffer._readbackSize ??= byteLength;
    const encoder = device.createCommandEncoder({ label: buffer._label ? `${buffer._label}-readback` : "storage-readback" });
    encoder.copyBufferToBuffer(buffer._buffer, byteOffset, staging, 0, byteLength);
    device.queue.submit([encoder.finish()]);
    buffer._readPendingOffset = byteOffset;
    buffer._readPendingLength = byteLength;
    buffer._readPending = staging
        .mapAsync(GPUMapMode.READ, 0, byteLength)
        .then(() => {
            try {
                return staging.getMappedRange(0, byteLength).slice(0);
            } finally {
                staging.unmap();
            }
        })
        .finally(() => {
            buffer._readPending = undefined;
            buffer._readPendingOffset = undefined;
            buffer._readPendingLength = undefined;
        });
    return buffer._readPending;
}

/** Destroy a storage buffer. Repeated disposal is a no-op. */
export function disposeStorageBuffer(buffer: StorageBuffer): void {
    if (buffer._destroyed) {
        return;
    }
    if (!("_engine" in buffer) || !buffer._engine._storageBuffers?.has(buffer)) {
        throw new Error("StorageBuffer is not a live registered allocation.");
    }
    buffer._readback?.destroy();
    buffer._readback = undefined;
    buffer._readbackDevice = undefined;
    buffer._readbackSize = undefined;
    buffer._buffer?.destroy();
    buffer._buffer = null;
    buffer._engine._storageBuffers.delete(buffer);
    buffer._data = null;
    buffer._destroyed = true;
    buffer._engine._resourceEpoch = ((buffer._engine._resourceEpoch ?? 0) + 1) | 0;
    if (buffer._engine._storageBuffers.size === 0) {
        buffer._engine._storageBuffers = undefined;
        buffer._engine._disposeStorageBuffers = undefined;
    }
}

/** @internal Dispose all live storage allocations before their engine device is destroyed. */
export function _disposeStorageBuffers(engine: EngineContext): void {
    for (const buffer of [...(engine._storageBuffers ?? [])]) {
        disposeStorageBuffer(buffer);
    }
}
