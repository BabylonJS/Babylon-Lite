import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { clearStorageBuffer, readStorageBufferAfterFrame, updateStorageBufferRange } from "../../../packages/babylon-lite/src/resource/storage-buffer-operations";
import { createStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";

const gpuGlobals = globalThis as unknown as Omit<typeof globalThis, "GPUBufferUsage" | "GPUMapMode"> & {
    GPUBufferUsage?: Record<string, number>;
    GPUMapMode?: { READ: number };
};
gpuGlobals.GPUBufferUsage ??= { STORAGE: 0x80, COPY_SRC: 0x4, COPY_DST: 0x8, MAP_READ: 0x1 };
gpuGlobals.GPUMapMode ??= { READ: 0x1 };

function makeEngine() {
    const source = { destroy: vi.fn() } as unknown as GPUBuffer;
    const mapped = new Uint8Array([1, 2, 3, 4]).buffer;
    const staging = {
        mapAsync: vi.fn(async () => undefined),
        getMappedRange: vi.fn(() => mapped),
        unmap: vi.fn(),
        destroy: vi.fn(),
    } as unknown as GPUBuffer;
    const frameEncoder = { clearBuffer: vi.fn(), copyBufferToBuffer: vi.fn() };
    const directEncoder = { clearBuffer: vi.fn(), finish: vi.fn(() => ({})) };
    const device = {
        limits: { maxBufferSize: 1024 },
        createBuffer: vi.fn().mockReturnValueOnce(source).mockReturnValue(staging),
        createCommandEncoder: vi.fn(() => directEncoder),
        queue: { writeBuffer: vi.fn(), submit: vi.fn() },
    } as unknown as GPUDevice;
    const engine = { _device: device } as EngineContext;
    return { engine, device, source, staging, frameEncoder, directEncoder };
}

describe("compat storage-buffer operations", () => {
    it("records GPU clears in-frame and submits them directly out-of-frame", () => {
        const { engine, device, source, frameEncoder, directEncoder } = makeEngine();
        const storage = createStorageBuffer(engine, 16, { writable: true });
        engine._currentEncoder = frameEncoder as unknown as GPUCommandEncoder;
        clearStorageBuffer(engine, storage, 4, 8);
        expect(frameEncoder.clearBuffer).toHaveBeenCalledWith(source, 4, 8);

        engine._currentEncoder = undefined!;
        clearStorageBuffer(engine, storage);
        expect(directEncoder.clearBuffer).toHaveBeenCalledWith(source, 0, 16);
        expect(device.queue.submit).toHaveBeenCalledOnce();
    });

    it("aligns and pads byte-sized updates without rejecting valid Babylon.js ranges", () => {
        const { engine, device, source } = makeEngine();
        const storage = createStorageBuffer(engine, 16, { writable: true });
        updateStorageBufferRange(engine, storage, new Uint16Array([0x1234]), 2);

        const call = vi.mocked(device.queue.writeBuffer).mock.calls[0]!;
        expect(call[0]).toBe(source);
        expect(call[1]).toBe(0);
        expect(Array.from(call[2] as Uint8Array)).toEqual([0, 0, 0x34, 0x12]);
    });

    it("records frame readback before submit and maps it from the post-submit hook", async () => {
        const { engine, source, staging, frameEncoder } = makeEngine();
        const storage = createStorageBuffer(engine, 16, { writable: true });
        engine._currentEncoder = frameEncoder as unknown as GPUCommandEncoder;

        const pending = readStorageBufferAfterFrame(storage, 0, 4);
        expect(frameEncoder.copyBufferToBuffer).toHaveBeenCalledWith(source, 0, staging, 0, 4);
        engine._currentEncoder = undefined!;
        engine._gpuTimerResolve!();

        await expect(pending).resolves.toEqual(new Uint8Array([1, 2, 3, 4]).buffer);
        expect(staging.destroy).toHaveBeenCalledOnce();
    });

    it("rejects immediate readback while a frame is active", async () => {
        const { engine, frameEncoder } = makeEngine();
        const storage = createStorageBuffer(engine, 16, { writable: true });
        engine._currentEncoder = frameEncoder as unknown as GPUCommandEncoder;

        await expect(readStorageBufferAfterFrame(storage, 0, 4, true)).rejects.toThrow(/cannot flush an active/);
    });
});
