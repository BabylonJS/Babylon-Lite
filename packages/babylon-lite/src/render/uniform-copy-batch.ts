import { U8 } from "../engine/typed-arrays.js";
import { BU } from "../engine/gpu-flags.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import type { DrawBatchState } from "./draw-update-batches.js";
import type { DrawUpdateBatch } from "./renderable.js";

interface UniformCopy {
    buffer: GPUBuffer;
    data: ArrayBufferView<ArrayBufferLike>;
    offset: number;
    /** @internal Byte offset in the packed upload image, assigned while queueing. */
    _uploadOffset: number;
    /** @internal Byte view over `data`, cached across frames. Callers queue the SAME staging array every
     *  frame (a material's uniform image, a packet's system block), so rebuilding this view per copy per
     *  frame was hundreds of throwaway allocations per frame in a material-heavy scene. Rebuilt only when
     *  `data` itself is a different object. */
    _u8?: Uint8Array;
}

/** @internal Per-render-task staging state for batched uniform uploads. */
export interface UniformCopyBatch extends DrawUpdateBatch {
    /** @internal */
    readonly _copies: UniformCopy[];
    /** @internal Unavailable for reuse once its generation has been released. */
    _retired: boolean;
    /** @internal Specialized collector installed for this cached generation. */
    _collector?: NonNullable<RenderTargetSignature["_collectBatches"]>;
    /** Queue a fixed-size internal uniform image; its contents are read when the batch flushes. */
    queue(buffer: GPUBuffer, data: ArrayBufferView<ArrayBufferLike>, offset?: number): void;
}

let _batches: WeakMap<RenderTargetSignature, UniformCopyBatch> | null = null;

/** @internal Return the task-local batch associated with one render-target signature. */
export function getUniformCopyBatch(signature: RenderTargetSignature): UniformCopyBatch {
    _batches ??= new WeakMap();
    const cached = _batches.get(signature);
    if (cached && !cached._retired) {
        return cached;
    }
    const copies: UniformCopy[] = [];
    let count = 0;
    let totalBytes = 0;
    let buffer: GPUBuffer | null = null;
    let device: GPUDevice | null = null;
    let bytes = new U8(0);
    const created: UniformCopyBatch = {
        _copies: copies,
        _retired: false,
        reset(): void {
            count = totalBytes = 0;
        },
        flush(engine): void {
            if (!count) {
                return;
            }
            if (device !== engine._device) {
                buffer?.destroy();
                buffer = null;
                device = engine._device;
                bytes = new U8(0);
            }
            if (!buffer || bytes.byteLength < totalBytes) {
                let capacity = bytes.byteLength || 256;
                while (capacity < totalBytes) {
                    capacity *= 2;
                }
                buffer?.destroy();
                buffer = engine._device.createBuffer({
                    label: "render-task-uniform-upload",
                    size: capacity,
                    usage: BU.COPY_SRC | BU.COPY_DST,
                });
                bytes = new U8(capacity);
            }
            for (let i = 0; i < count; i++) {
                const copy = copies[i]!;
                const u8 = (copy._u8 ??= new U8(copy.data.buffer, copy.data.byteOffset, copy.data.byteLength));
                bytes.set(u8, copy._uploadOffset);
            }
            engine._device.queue.writeBuffer(buffer, 0, bytes.buffer, bytes.byteOffset, totalBytes);
            for (let i = 0; i < count; i++) {
                const copy = copies[i]!;
                engine._currentEncoder.copyBufferToBuffer(buffer, copy._uploadOffset, copy.buffer, copy.offset, copy.data.byteLength);
            }
        },
        destroy(): void {
            created._retired = true;
            try {
                buffer?.destroy();
            } catch (error) {
                console.error("GPU resource retirement failed.", error);
            }
            buffer = null;
            device = null;
            bytes = new U8(0);
            copies.length = 0;
            count = totalBytes = 0;
        },
        queue(destination, data, offset = 0): void {
            if ((data.byteLength | offset) & 3) {
                throw new Error("Uniform copies require 4-byte-aligned sizes and destination offsets.");
            }
            const copy = copies[count++];
            if (copy) {
                if (copy.data !== data) {
                    copy._u8 = undefined;
                }
                copy.buffer = destination;
                copy.data = data;
                copy.offset = offset;
                copy._uploadOffset = totalBytes;
            } else {
                copies.push({ buffer: destination, data, offset, _uploadOffset: totalBytes });
            }
            totalBytes += data.byteLength;
        },
    };
    if (!signature._collectBatches || signature._collectBatches === cached?._collector) {
        const state: DrawBatchState = {
            _batches: [created],
            _reset: created.reset,
            _flush: created.flush,
            _select(lists): DrawBatchState | undefined {
                for (const list of lists) {
                    for (const binding of list) {
                        if (binding._updateBatches?.includes(created)) {
                            return state;
                        }
                    }
                }
                return undefined;
            },
            _release(engine, retained): void {
                if (created._retired || retained?.some((state) => state?._batches.includes(created))) {
                    return;
                }
                created._retired = true;
                if (engine) {
                    retireGpuResources(engine, created.destroy);
                } else {
                    created.destroy();
                }
            },
        };
        signature._collectBatches = created._collector = (previous, binding) => previous ?? (binding._updateBatches?.includes(created) ? state : undefined);
    }
    _batches.set(signature, created);
    return created;
}
