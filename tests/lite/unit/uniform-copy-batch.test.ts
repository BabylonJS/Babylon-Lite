import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { getUniformCopyBatch } from "../../../packages/babylon-lite/src/render/uniform-copy-batch";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage"> & {
    GPUBufferUsage?: { COPY_SRC: number; COPY_DST: number };
};
gpuGlobals.GPUBufferUsage ??= { COPY_SRC: 0x4, COPY_DST: 0x8 } as unknown as GPUBufferUsage;

function makeDevice() {
    const buffers: GPUBuffer[] = [];
    const device = {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const buffer = { size: descriptor.size, destroy: vi.fn() } as unknown as GPUBuffer;
            buffers.push(buffer);
            return buffer;
        }),
        queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    return { device, buffers };
}

describe("uniform copy batching", () => {
    it("recreates its staging buffer after device recovery", () => {
        const signature = {} as RenderTargetSignature;
        const batch = getUniformCopyBatch(signature);
        const first = makeDevice();
        const second = makeDevice();
        const firstEncoder = { copyBufferToBuffer: vi.fn() } as unknown as GPUCommandEncoder;
        const secondEncoder = { copyBufferToBuffer: vi.fn() } as unknown as GPUCommandEncoder;
        const destination = {} as GPUBuffer;

        batch.queue(destination, new Float32Array([1, 2, 3, 4]));
        batch.flush({ _device: first.device, _currentEncoder: firstEncoder } as unknown as EngineContext);
        expect(first.buffers).toHaveLength(1);

        batch.reset();
        batch.queue(destination, new Float32Array([5, 6, 7, 8]));
        batch.flush({ _device: second.device, _currentEncoder: secondEncoder } as unknown as EngineContext);

        expect(first.buffers[0]!.destroy).toHaveBeenCalledTimes(1);
        expect(second.buffers).toHaveLength(1);
        expect(secondEncoder.copyBufferToBuffer).toHaveBeenCalledWith(second.buffers[0], 0, destination, 0, 16);
        batch.destroy();
    });
});
