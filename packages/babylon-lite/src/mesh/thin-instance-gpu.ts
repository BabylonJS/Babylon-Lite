/** Thin instance GPU buffer sync — dynamically loaded only by scenes with thin instances.
 *  Keeps the standard renderable chunk unchanged for scenes without thin instances. */

import type { ThinInstanceData } from "./thin-instance.js";

/** Sync thin instance matrix + optional color GPU buffers and bind to vertex slots. */
export function syncThinInstanceBuffers(device: GPUDevice, ti: ThinInstanceData, pass: GPURenderPassEncoder | GPURenderBundleEncoder, slot: number, hasColor: boolean): number {
    if (ti._version !== ti._gpuVersion) {
        const byteSize = ti.count * 64;
        if (!ti._gpuBuffer || ti._gpuBuffer.size < byteSize) {
            ti._gpuBuffer?.destroy();
            ti._gpuBuffer = device.createBuffer({
                size: ti._capacity * 64,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
        }
        device.queue.writeBuffer(ti._gpuBuffer, 0, ti.matrices.buffer, ti.matrices.byteOffset, byteSize);
        ti._gpuVersion = ti._version;
    }
    if (ti._gpuBuffer) {
        pass.setVertexBuffer(slot++, ti._gpuBuffer);
    }

    if (hasColor && ti.colors) {
        if (ti._colorVersion !== ti._colorGpuVersion) {
            const colorByteSize = ti.count * 16;
            if (!ti._colorGpuBuffer || ti._colorGpuBuffer.size < colorByteSize) {
                ti._colorGpuBuffer?.destroy();
                ti._colorGpuBuffer = device.createBuffer({
                    size: ti._capacity * 16,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
            }
            device.queue.writeBuffer(ti._colorGpuBuffer, 0, ti.colors.buffer, ti.colors.byteOffset, colorByteSize);
            ti._colorGpuVersion = ti._colorVersion;
        }
        if (ti._colorGpuBuffer) {
            pass.setVertexBuffer(slot++, ti._colorGpuBuffer);
        }
    }

    return slot;
}
