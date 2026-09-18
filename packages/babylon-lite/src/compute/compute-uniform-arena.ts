import type { UniformBufferOptions } from "./compute-uniform-buffer.js";
import { _getUniformBufferHandle, createUniformBuffer, disposeUniformBuffer } from "./compute-uniform-buffer.js";
import type { UniformBuffer } from "./compute-uniform-buffer.js";
import { align } from "../resource/gpu-buffers.js";
import type { ComputeTask } from "./compute-task.js";

/** Task-owned dynamic-uniform storage with one aligned slice per dispatch slot. */
export interface ComputeUniformArena {
    readonly buffer: UniformBuffer;
    readonly slotByteLength: number;
    readonly slotStride: number;
    readonly slotCount: number;
    /** @internal */
    readonly _task: ComputeTask;
    /** @internal */
    _dirtyStart: number;
    /** @internal */
    _dirtyEnd: number;
    /** @internal */
    _destroyed: boolean;
}

/** Create a task-owned uniform arena. The task disposes it automatically. */
export function createComputeUniformArena(task: ComputeTask, slotByteLength: number, slotCount: number, options?: UniformBufferOptions): ComputeUniformArena {
    if (task._disposed) {
        throw new Error(`ComputeTask "${task.name}" has been disposed.`);
    }
    if (!Number.isSafeInteger(slotByteLength) || slotByteLength <= 0 || (slotByteLength & 3) !== 0) {
        throw new Error("ComputeUniformArena: slotByteLength must be a positive safe integer and a multiple of 4.");
    }
    if (!Number.isSafeInteger(slotCount) || slotCount <= 0) {
        throw new Error("ComputeUniformArena: slotCount must be a positive safe integer.");
    }
    const alignment = Number(task.engine._device.limits.minUniformBufferOffsetAlignment) || 1;
    const slotStride = align(slotByteLength, alignment);
    const byteLength = slotStride * slotCount;
    if (!Number.isSafeInteger(slotStride) || !Number.isSafeInteger(byteLength)) {
        throw new Error("ComputeUniformArena: aligned stride and total byte length must be safe integers.");
    }
    const arena: ComputeUniformArena = {
        buffer: createUniformBuffer(task.engine, byteLength, options),
        slotByteLength,
        slotStride,
        slotCount,
        _task: task,
        _dirtyStart: Number.POSITIVE_INFINITY,
        _dirtyEnd: 0,
        _destroyed: false,
    };
    const arenas = (task._uniformArenas ??= []);
    if (arenas.length === 0) {
        task._flushOwned = () => {
            for (let i = 0; i < arenas.length; i++) {
                _flushComputeUniformArena(arenas[i]!);
            }
        };
        task._disposeOwned = () => {
            for (const owned of arenas) {
                _disposeComputeUniformArena(owned);
            }
            arenas.length = 0;
        };
    }
    arenas.push(arena);
    return arena;
}

function validateSlot(arena: ComputeUniformArena, slot: number): void {
    if (arena._destroyed) {
        throw new Error("ComputeUniformArena has been disposed.");
    }
    if (!Number.isInteger(slot) || slot < 0 || slot >= arena.slotCount) {
        throw new Error(`ComputeUniformArena: slot must be an integer in [0, ${arena.slotCount - 1}].`);
    }
}

/** Return the dynamic offset for one arena slot. */
export function getComputeUniformSlotOffset(arena: ComputeUniformArena, slot: number): number {
    validateSlot(arena, slot);
    return slot * arena.slotStride;
}

/** Update CPU staging bytes for one slot. The task uploads all dirty slots once before its pass. */
export function updateComputeUniformSlot(arena: ComputeUniformArena, slot: number, data: ArrayBufferView, byteOffset = 0): void {
    validateSlot(arena, slot);
    if (!Number.isInteger(byteOffset) || byteOffset < 0 || (byteOffset & 3) !== 0) {
        throw new Error("ComputeUniformArena: byteOffset must be a non-negative multiple of 4.");
    }
    if ((data.byteLength & 3) !== 0) {
        throw new Error("ComputeUniformArena: update data must have a byte length that is a multiple of 4.");
    }
    if (byteOffset + data.byteLength > arena.slotByteLength) {
        throw new Error(`ComputeUniformArena: update exceeds the slot's ${arena.slotByteLength}-byte capacity.`);
    }
    if (data.byteLength === 0) {
        return;
    }
    const start = slot * arena.slotStride + byteOffset;
    arena.buffer._data!.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), start);
    arena._dirtyStart = Math.min(arena._dirtyStart, start);
    arena._dirtyEnd = Math.max(arena._dirtyEnd, start + data.byteLength);
}

/** @internal Upload one enclosing dirty range before the task's compute pass. */
export function _flushComputeUniformArena(arena: ComputeUniformArena): void {
    if (arena._destroyed || arena._dirtyEnd <= arena._dirtyStart) {
        return;
    }
    const engine = arena._task.engine;
    const handle = _getUniformBufferHandle(engine, arena.buffer);
    const start = arena._dirtyStart;
    const size = arena._dirtyEnd - start;
    engine._device.queue.writeBuffer(handle, start, arena.buffer._data!.buffer, start, size);
    arena._dirtyStart = Number.POSITIVE_INFINITY;
    arena._dirtyEnd = 0;
}

/** @internal Dispose task-owned arena storage. */
export function _disposeComputeUniformArena(arena: ComputeUniformArena): void {
    if (arena._destroyed) {
        return;
    }
    arena._destroyed = true;
    disposeUniformBuffer(arena.buffer);
}
