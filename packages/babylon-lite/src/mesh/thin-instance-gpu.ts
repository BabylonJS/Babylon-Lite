/** Thin instance GPU buffer sync — dynamically loaded only by scenes with thin instances.
 *  Keeps the standard renderable chunk unchanged for scenes without thin instances. */

import type { ThinInstanceData } from "./thin-instance.js";
import type { EngineContext } from "../engine/engine.js";
import { packMat4IntoF32 } from "../math/pack-mat4-into-f32.js";

/** @internal Optional replacement buffers used by GPU culling after it compacts visible instances. */
export interface ThinInstanceDrawBuffers {
    readonly matrixBuffer: GPUBuffer;
    readonly colorBuffer: GPUBuffer | null;
}

/** @internal Sync CPU thin-instance data to GPU buffers, optionally with STORAGE usage for compute culling. */
export function syncThinInstanceGpuData(engine: EngineContext, ti: ThinInstanceData, hasColor: boolean): void {
    const device = engine._device;
    const needsStorage = ti._gpuCullingEnabled;
    if (ti._version !== ti._gpuVersion || ti._gpuBufferStorage !== needsStorage) {
        const byteSize = ti.count * 64;
        let bufferRecreated = false;
        if (!ti._gpuBuffer || ti._gpuBuffer.size < byteSize || ti._gpuBufferStorage !== needsStorage) {
            ti._gpuBuffer?.destroy();
            ti._gpuBuffer = device.createBuffer({
                size: Math.max(ti._capacity * 64, 4),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | (needsStorage ? GPUBufferUsage.STORAGE : 0),
            });
            ti._gpuBufferStorage = needsStorage;
            bufferRecreated = true;
        }
        // Upload only the dirty range (or full range if buffer was just created)
        const dirtyMin = bufferRecreated ? 0 : ti._dirtyMin;
        const dirtyMax = bufferRecreated ? ti.count : Math.min(ti._dirtyMax, ti.count);
        if (dirtyMax > dirtyMin) {
            const minByte = dirtyMin * 64;
            const maxByte = dirtyMax * 64;
            if (ti.matrices instanceof Float32Array) {
                // Fast path: F32 source — direct byte copy, no per-instance pack.
                device.queue.writeBuffer(ti._gpuBuffer, minByte, ti.matrices.buffer, ti.matrices.byteOffset + minByte, maxByte - minByte);
            } else {
                // F64 source (HPM-on path) — pack each dirty instance into a
                // per-mesh reused F32 upload scratch, then writeBuffer the
                // dirty subrange. Scratch is sized to capacity in F32 floats
                // and grown when capacity grows; never per-frame allocated.
                const neededFloats = ti._capacity * 16;
                if (!ti._uploadF32 || ti._uploadF32.length < neededFloats) {
                    ti._uploadF32 = new Float32Array(neededFloats);
                }
                const upload = ti._uploadF32;
                for (let i = dirtyMin; i < dirtyMax; i++) {
                    packMat4IntoF32(upload, ti.matrices, i * 16, i * 16);
                }
                device.queue.writeBuffer(ti._gpuBuffer, minByte, upload.buffer, upload.byteOffset + minByte, maxByte - minByte);
            }
        }
        ti._dirtyMin = ti.count;
        ti._dirtyMax = 0;
        ti._gpuVersion = ti._version;
    }

    if (hasColor && ti.colors) {
        if (ti._colorVersion !== ti._colorGpuVersion || ti._colorGpuBufferStorage !== needsStorage) {
            const colorByteSize = ti.count * 16;
            if (!ti._colorGpuBuffer || ti._colorGpuBuffer.size < colorByteSize || ti._colorGpuBufferStorage !== needsStorage) {
                ti._colorGpuBuffer?.destroy();
                ti._colorGpuBuffer = device.createBuffer({
                    size: Math.max(ti._capacity * 16, 4),
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | (needsStorage ? GPUBufferUsage.STORAGE : 0),
                });
                ti._colorGpuBufferStorage = needsStorage;
            }
            device.queue.writeBuffer(ti._colorGpuBuffer, 0, ti.colors.buffer, ti.colors.byteOffset, colorByteSize);
            ti._colorGpuVersion = ti._colorVersion;
        }
    }
}

/** Sync thin instance matrix + optional color GPU buffers and bind to vertex slots. */
export function syncThinInstanceBuffers(
    engine: EngineContext,
    ti: ThinInstanceData,
    pass: GPURenderPassEncoder | GPURenderBundleEncoder,
    slot: number,
    hasColor: boolean,
    drawBuffers?: ThinInstanceDrawBuffers | null
): number {
    syncThinInstanceGpuData(engine, ti, hasColor);
    const matrixBuffer = drawBuffers?.matrixBuffer ?? ti._gpuBuffer;
    if (matrixBuffer) {
        pass.setVertexBuffer(slot++, matrixBuffer);
    }

    if (hasColor) {
        const colorBuffer = drawBuffers?.colorBuffer ?? ti._colorGpuBuffer;
        if (colorBuffer) {
            pass.setVertexBuffer(slot++, colorBuffer);
        }
    }

    return slot;
}
