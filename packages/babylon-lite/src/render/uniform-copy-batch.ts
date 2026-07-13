import { U8 } from "../engine/typed-arrays.js";
import { BU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { DrawUpdateBatch } from "./renderable.js";

interface UniformCopy {
    buffer: GPUBuffer;
    data: ArrayBufferView<ArrayBufferLike>;
    offset: number;
}

/** @internal Per-render-task staging state for batched uniform uploads. */
export interface UniformCopyBatch extends DrawUpdateBatch {
    /** @internal */
    readonly _copies: UniformCopy[];
    /** @internal */
    _count: number;
    /** @internal */
    _buffer: GPUBuffer | null;
    /** @internal */
    _device: GPUDevice | null;
    /** @internal */
    _bytes: Uint8Array;
    queue(buffer: GPUBuffer, data: ArrayBufferView<ArrayBufferLike>, offset?: number): void;
}

let _batches: WeakMap<RenderTargetSignature, UniformCopyBatch> | null = null;

/** @internal Return the task-local batch associated with one render-target signature. */
export function getUniformCopyBatch(signature: RenderTargetSignature): UniformCopyBatch {
    _batches ??= new WeakMap();
    const batch = _batches.get(signature);
    if (batch) {
        return batch;
    }
    const created: UniformCopyBatch = {
        _copies: [],
        _count: 0,
        _buffer: null,
        _device: null,
        _bytes: new U8(0),
        reset(): void {
            created._count = 0;
        },
        flush(engine): void {
            flushUniformCopyBatch(engine, created);
        },
        destroy(): void {
            created._buffer?.destroy();
            created._buffer = null;
            created._device = null;
            created._bytes = new U8(0);
            created._copies.length = 0;
            created._count = 0;
            _batches?.delete(signature);
        },
        queue(buffer, data, offset = 0): void {
            const index = created._count++;
            const copy = created._copies[index];
            if (copy) {
                copy.buffer = buffer;
                copy.data = data;
                copy.offset = offset;
            } else {
                created._copies.push({ buffer, data, offset });
            }
        },
    };
    _batches.set(signature, created);
    return created;
}

function flushUniformCopyBatch(engine: EngineContext, batch: UniformCopyBatch): void {
    const copies = batch._copies;
    const count = batch._count;
    if (count === 0) {
        return;
    }
    let totalBytes = 0;
    for (let i = 0; i < count; i++) {
        const copy = copies[i]!;
        if ((copy.data.byteLength & 3) !== 0 || (copy.offset & 3) !== 0) {
            throw new Error("Uniform copies require 4-byte-aligned sizes and destination offsets.");
        }
        totalBytes = align4(totalBytes) + copy.data.byteLength;
    }
    ensureCapacity(engine, batch, totalBytes);
    const bytes = batch._bytes;
    let cursor = 0;
    for (let i = 0; i < count; i++) {
        const copy = copies[i]!;
        cursor = align4(cursor);
        bytes.set(new U8(copy.data.buffer, copy.data.byteOffset, copy.data.byteLength), cursor);
        cursor += copy.data.byteLength;
    }
    engine._device.queue.writeBuffer(batch._buffer!, 0, bytes.buffer, bytes.byteOffset, totalBytes);
    cursor = 0;
    for (let i = 0; i < count; i++) {
        const copy = copies[i]!;
        cursor = align4(cursor);
        engine._currentEncoder.copyBufferToBuffer(batch._buffer!, cursor, copy.buffer, copy.offset, copy.data.byteLength);
        cursor += copy.data.byteLength;
    }
}

function ensureCapacity(engine: EngineContext, batch: UniformCopyBatch, requiredBytes: number): void {
    if (batch._device !== engine._device) {
        batch._buffer?.destroy();
        batch._buffer = null;
        batch._device = engine._device;
        batch._bytes = new U8(0);
    }
    if (batch._buffer && batch._bytes.byteLength >= requiredBytes) {
        return;
    }
    let capacity = Math.max(256, batch._bytes.byteLength);
    while (capacity < requiredBytes) {
        capacity *= 2;
    }
    batch._buffer?.destroy();
    batch._buffer = engine._device.createBuffer({
        label: "render-task-uniform-upload",
        size: capacity,
        usage: BU.COPY_SRC | BU.COPY_DST,
    });
    batch._bytes = new U8(capacity);
}

function align4(value: number): number {
    return (value + 3) & ~3;
}
