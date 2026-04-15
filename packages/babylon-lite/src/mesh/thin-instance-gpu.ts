/** Thin instance GPU buffer sync — dynamically loaded only by scenes with thin instances.
 *  Keeps the standard renderable chunk unchanged for scenes without thin instances. */

import type { ThinInstanceData } from "./thin-instance.js";
import type { EngineContextInternal } from "../engine/engine.js";

/** Sync thin instance matrix + optional color GPU buffers and bind to vertex slots. */
export function syncThinInstanceBuffers(
    engine: EngineContextInternal,
    ti: ThinInstanceData,
    pass: GPURenderPassEncoder | GPURenderBundleEncoder,
    slot: number,
    hasColor: boolean
): number {
    const device = engine.device;
    if (ti._version !== ti._gpuVersion) {
        const byteSize = ti.count * 64;
        let bufferRecreated = false;
        if (!ti._gpuBuffer || ti._gpuBuffer.size < byteSize) {
            ti._gpuBuffer?.destroy();
            ti._gpuBuffer = device.createBuffer({
                size: ti._capacity * 64,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            bufferRecreated = true;
        }
        // Upload only the dirty range (or full range if buffer was just created)
        const dirtyMin = bufferRecreated ? 0 : ti._dirtyMin;
        const dirtyMax = bufferRecreated ? ti.count : Math.min(ti._dirtyMax, ti.count);
        if (dirtyMax > dirtyMin) {
            const minByte = dirtyMin * 64;
            const maxByte = dirtyMax * 64;
            device.queue.writeBuffer(ti._gpuBuffer, minByte, ti.matrices.buffer, ti.matrices.byteOffset + minByte, maxByte - minByte);
        }
        ti._dirtyMin = ti.count;
        ti._dirtyMax = 0;
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
