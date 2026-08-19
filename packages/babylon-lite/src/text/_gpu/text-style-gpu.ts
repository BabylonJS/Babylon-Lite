/** Owns the per-TextData style-palette storage buffer — one entry per distinct (color, scale)
 *  a run draws with, indexed by the high 16 bits of an instance's packed word. Lives beside the
 *  instance buffer in each renderer's per-block GPU record because, like that buffer, it mirrors
 *  CPU state owned by the TextData rather than by the shared atlas. */

import { TEXT_STYLE_BYTES } from "../text-data.js";
import type { TextData } from "../text-data.js";

/** @internal Style-palette GPU state, embedded in each renderer's per-block GPU record. */
export interface TextStyleGpu {
    styleBuf: GPUBuffer;
    styleCap: number;
    uploadedStyleVersion: number;
}

export function createStyleBuffer(device: GPUDevice, entries: number): GPUBuffer {
    return device.createBuffer({
        label: "text-styles",
        size: entries * TEXT_STYLE_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
}

/** Grow the style buffer to fit `data`'s palette and upload it when stale. Returns true when the
 *  buffer was recreated, in which case the caller must rebuild any bind group or render bundle
 *  that captured the old one. A palette whose version is unchanged — the steady state for static
 *  text, and for animated text too once its entry count settles — costs nothing here. */
export function ensureStyleGpu(device: GPUDevice, data: TextData, gpu: TextStyleGpu): boolean {
    const needed = Math.max(1, data._styleCount);
    let recreated = false;
    if (needed > gpu.styleCap) {
        gpu.styleBuf.destroy();
        let cap = Math.max(1, gpu.styleCap);
        while (cap < needed) {
            cap *= 2;
        }
        gpu.styleBuf = createStyleBuffer(device, cap);
        gpu.styleCap = cap;
        gpu.uploadedStyleVersion = -1;
        recreated = true;
    }
    if (gpu.uploadedStyleVersion !== data._styleVersion) {
        if (data._styleCount > 0) {
            const s = data._styles;
            device.queue.writeBuffer(gpu.styleBuf, 0, s.buffer as ArrayBuffer, s.byteOffset, data._styleCount * TEXT_STYLE_BYTES);
        }
        gpu.uploadedStyleVersion = data._styleVersion;
    }
    return recreated;
}
