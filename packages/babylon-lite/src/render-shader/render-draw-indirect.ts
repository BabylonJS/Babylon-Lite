import { BU } from "../engine/gpu-flags.js";
import type { StorageBuffer } from "../resource/storage-buffer.js";
import { _getStorageBufferHandle } from "../resource/storage-buffer.js";
import type { RenderDraw } from "./render-draw.js";
import { _assertRenderShaderLive } from "./render-shader.js";

/** Bytes of `drawIndirect` arguments; `drawIndexedIndirect` needs 20. */
const DRAW_ARGS_BYTES = 16;
const INDEXED_DRAW_ARGS_BYTES = 20;

function recordIndirect(pass: GPURenderPassEncoder, draw: RenderDraw): void {
    const engine = draw.shader._program._engine;
    const handle = _getStorageBufferHandle(engine, draw._indirectBuffer!);
    if (draw._indexBuffer) {
        pass.drawIndexedIndirect(handle, draw._indirectOffset!);
    } else {
        pass.drawIndirect(handle, draw._indirectOffset!);
    }
}

/**
 * Take the draw's counts from GPU memory: `buffer` (created with `indirect: true`) holds WebGPU's
 * `drawIndirect` arguments at `byteOffset` (`drawIndexedIndirect` arguments for an indexed draw), so a
 * compute pass can decide how many instances to draw without a CPU readback.
 * {@link setRenderDrawCount} switches the draw back to direct counts.
 */
export function setRenderDrawIndirect(draw: RenderDraw, buffer: StorageBuffer, byteOffset = 0): void {
    _assertRenderShaderLive(draw.shader);
    if (buffer._destroyed || buffer._engine !== draw.shader._program._engine || (buffer._usage & BU.INDIRECT) === 0) {
        throw new Error("setRenderDrawIndirect: buffer must be a live allocation of the same engine created with indirect: true.");
    }
    const size = draw._indexBuffer ? INDEXED_DRAW_ARGS_BYTES : DRAW_ARGS_BYTES;
    if (!Number.isInteger(byteOffset) || byteOffset < 0 || (byteOffset & 3) !== 0 || byteOffset + size > buffer.byteLength) {
        throw new Error(`setRenderDrawIndirect: ${size} argument bytes at offset ${byteOffset} must fit the ${buffer.byteLength}-byte buffer at a multiple of 4.`);
    }
    draw._indirectBuffer = buffer;
    draw._indirectOffset = byteOffset;
    draw._record = recordIndirect;
}
