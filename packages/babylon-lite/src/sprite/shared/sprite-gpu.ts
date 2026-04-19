/**
 * Sprite CPU→GPU sync helpers.
 *
 * Each layer/system owns a single `Float32Array` packed buffer sized at
 * `capacity × stride`. On per-frame sync:
 *   1. If `_version === _gpuVersion`, skip.
 *   2. Otherwise, compute a single contiguous `[dirtyMin, dirtyMax)` write
 *      and dispatch one `device.queue.writeBuffer`.
 *
 * Capacity grows 2× on overflow (fresh allocation + copy + re-create GPU buffer).
 * Sprite indices remain stable across grows. Removal is swap-remove.
 */

import type { EngineContextInternal } from "../../engine/engine.js";

/** State shared by all sprite layer/system flavours. */
export interface SpriteStorage {
    /** CPU-side packed instance data. */
    data: Float32Array;
    /** Active sprite count. */
    count: number;
    /** Allocated capacity in sprites. */
    capacity: number;
    /** Floats per sprite. */
    readonly stride: number;
    /** Version bumped on every CPU mutation. */
    version: number;
    /** Last version uploaded to the GPU. */
    gpuVersion: number;
    /** Inclusive lower dirty bound in slots. */
    dirtyMin: number;
    /** Exclusive upper dirty bound in slots. */
    dirtyMax: number;
    /** GPU buffer (lazily created at first sync). */
    gpuBuffer: GPUBuffer | null;
}

export function createSpriteStorage(initialCapacity: number, stride: number): SpriteStorage {
    return {
        data: new Float32Array(initialCapacity * stride),
        count: 0,
        capacity: initialCapacity,
        stride,
        version: 1,
        gpuVersion: 0,
        dirtyMin: 0,
        dirtyMax: 0,
        gpuBuffer: null,
    };
}

/** Mark the slot range [start, end) as dirty. */
export function markDirty(storage: SpriteStorage, start: number, end: number): void {
    if (storage.dirtyMin >= storage.dirtyMax) {
        storage.dirtyMin = start;
        storage.dirtyMax = end;
    } else {
        if (start < storage.dirtyMin) {
            storage.dirtyMin = start;
        }
        if (end > storage.dirtyMax) {
            storage.dirtyMax = end;
        }
    }
    storage.version++;
}

/** Ensure capacity for `requested` sprites. Grows 2× on overflow.
 *  Returns true if the GPU buffer must be re-created (CPU storage was reallocated). */
export function ensureCapacity(storage: SpriteStorage, requested: number): boolean {
    if (requested <= storage.capacity) {
        return false;
    }
    let newCap = storage.capacity > 0 ? storage.capacity : 8;
    while (newCap < requested) {
        newCap *= 2;
    }
    const newData = new Float32Array(newCap * storage.stride);
    newData.set(storage.data);
    storage.data = newData;
    storage.capacity = newCap;
    return true;
}

/** Swap-remove: last slot moves into the gap. Caller must call `markDirty(storage, index, count)`. */
export function swapRemove(storage: SpriteStorage, index: number): void {
    const last = storage.count - 1;
    if (index !== last) {
        const stride = storage.stride;
        storage.data.copyWithin(index * stride, last * stride, last * stride + stride);
    }
    storage.count--;
}

/**
 * Sync CPU storage to GPU. Allocates / reallocates the GPU buffer as needed,
 * writes the dirty range in a single `writeBuffer` call, and resets dirty bounds.
 *
 * @param label Diagnostic label for new GPU buffers (e.g. "sprite-2d-instances").
 * @param onBufferReplaced Optional callback fired when a fresh GPU buffer is created
 *   (capacity grew or first allocation). Used by renderables to refresh cached refs.
 */
export function syncSpriteStorage(engine: EngineContextInternal, storage: SpriteStorage, label: string, onBufferReplaced?: (buf: GPUBuffer) => void): void {
    if (storage.version === storage.gpuVersion && storage.gpuBuffer) {
        return;
    }
    const device = engine.device;
    const requiredBytes = storage.capacity * storage.stride * 4;

    let recreated = false;
    if (!storage.gpuBuffer || storage.gpuBuffer.size < requiredBytes) {
        if (storage.gpuBuffer) {
            storage.gpuBuffer.destroy();
        }
        storage.gpuBuffer = device.createBuffer({
            label,
            size: requiredBytes,
            // STORAGE: 3D sprite renderables (anchored + billboards) read this buffer
            //   as `var<storage, read>` at @group(1) @binding(3) (per docs/architecture/26-sprites.md
            //   blocker 4 — sort indirection lives in a separate per-instance Uint32 buffer).
            // VERTEX: Sprite2DLayer still binds it as a per-instance vertex attribute (no
            //   sort indirection needed for screen-space layers).
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        recreated = true;
        // Force full upload after reallocation.
        storage.dirtyMin = 0;
        storage.dirtyMax = storage.count;
    }

    if (storage.dirtyMax > storage.dirtyMin && storage.count > 0) {
        const start = Math.max(0, Math.min(storage.dirtyMin, storage.count));
        const end = Math.min(storage.dirtyMax, storage.count);
        if (end > start) {
            const offsetBytes = start * storage.stride * 4;
            const lengthFloats = (end - start) * storage.stride;
            device.queue.writeBuffer(storage.gpuBuffer, offsetBytes, storage.data.buffer, storage.data.byteOffset + offsetBytes, lengthFloats * 4);
        }
    }

    storage.dirtyMin = 0;
    storage.dirtyMax = 0;
    storage.gpuVersion = storage.version;

    if (recreated && onBufferReplaced && storage.gpuBuffer) {
        onBufferReplaced(storage.gpuBuffer);
    }
}

/** Destroy GPU resources held by the storage. */
export function disposeSpriteStorage(storage: SpriteStorage): void {
    if (storage.gpuBuffer) {
        storage.gpuBuffer.destroy();
        storage.gpuBuffer = null;
    }
}
