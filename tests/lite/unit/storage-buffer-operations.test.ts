import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { addFramePostSubmitHook } from "../../../packages/babylon-lite/src/engine/frame-post-submit";
import { clearStorageBuffer, readStorageBufferAfterFrame, updateStorageBufferRange } from "../../../packages/babylon-lite/src/resource/storage-buffer-operations";
import { createStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";

const gpuGlobals = globalThis as unknown as Omit<typeof globalThis, "GPUBufferUsage" | "GPUMapMode"> & {
    GPUBufferUsage?: Record<string, number>;
    GPUMapMode?: { READ: number };
};
gpuGlobals.GPUBufferUsage ??= { STORAGE: 0x80, COPY_SRC: 0x4, COPY_DST: 0x8, MAP_READ: 0x1 };
gpuGlobals.GPUMapMode ??= { READ: 0x1 };

function makeEngine() {
    const sourceMapped = new ArrayBuffer(1024);
    const source = { destroy: vi.fn(), getMappedRange: vi.fn(() => sourceMapped), unmap: vi.fn() } as unknown as GPUBuffer;
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

    it("keeps an existing CPU recovery shadow synchronized without creating one for GPU-owned buffers", () => {
        const { engine } = makeEngine();
        const storage = createStorageBuffer(engine, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
        clearStorageBuffer(engine, storage, 4, 4);
        expect(storage._data).toEqual(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]));

        updateStorageBufferRange(engine, storage, new Uint8Array([9, 10]), 1);
        expect(storage._data).toEqual(new Uint8Array([0, 9, 10, 0, 0, 0, 0, 0]));

        const gpuOwned = createStorageBuffer(engine, 8, { writable: true });
        clearStorageBuffer(engine, gpuOwned);
        updateStorageBufferRange(engine, gpuOwned, new Uint8Array([11]), 1);
        expect(gpuOwned._data).toBeNull();
    });

    it("applies in-frame clears to the recovery shadow in GPU execution order", () => {
        const { engine, frameEncoder } = makeEngine();
        const storage = createStorageBuffer(engine, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
        engine._currentEncoder = frameEncoder as unknown as GPUCommandEncoder;

        clearStorageBuffer(engine, storage);
        updateStorageBufferRange(engine, storage, new Uint8Array([9, 10]), 1);
        expect(storage._data).toEqual(new Uint8Array([0, 9, 10, 0, 5, 6, 7, 8]));

        engine._gpuTaskTimerResolve!(engine._currentEncoder);
        expect(storage._data).toEqual(new Uint8Array(8));
    });

    it("discards shadow mutations recorded by an abandoned frame", () => {
        const { engine, frameEncoder } = makeEngine();
        const storage = createStorageBuffer(engine, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
        engine._currentEncoder = frameEncoder as unknown as GPUCommandEncoder;

        clearStorageBuffer(engine, storage);
        engine._currentEncoder = undefined!;
        updateStorageBufferRange(engine, storage, new Uint8Array([9, 10]), 1);

        const nextEncoder = {} as GPUCommandEncoder;
        engine._currentEncoder = nextEncoder;
        const laterFrameHook = vi.fn();
        addFramePostSubmitHook(engine, "frame", laterFrameHook);
        engine._gpuTaskTimerResolve!(nextEncoder);

        expect(laterFrameHook).toHaveBeenCalledOnce();
        expect(storage._data).toEqual(new Uint8Array([0, 9, 10, 0, 5, 6, 7, 8]));
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
        engine._gpuTaskTimerResolve!(engine._currentEncoder);

        await expect(pending).resolves.toEqual(new Uint8Array([1, 2, 3, 4]).buffer);
        expect(staging.destroy).toHaveBeenCalledOnce();
    });

    it("rejects frame readback when recording is abandoned", async () => {
        const { engine, staging, frameEncoder } = makeEngine();
        const storage = createStorageBuffer(engine, 16, { writable: true });
        engine._currentEncoder = frameEncoder as unknown as GPUCommandEncoder;

        const pending = readStorageBufferAfterFrame(storage, 0, 4);
        engine._currentEncoder = {} as GPUCommandEncoder;
        engine._gpuTaskTimerResolve!(engine._currentEncoder);

        await expect(pending).rejects.toThrow(/abandoned before its frame could be submitted/);
        expect(staging.destroy).toHaveBeenCalledOnce();
    });

    it("rejects immediate readback while a frame is active", async () => {
        const { engine, frameEncoder } = makeEngine();
        const storage = createStorageBuffer(engine, 16, { writable: true });
        engine._currentEncoder = frameEncoder as unknown as GPUCommandEncoder;

        await expect(readStorageBufferAfterFrame(storage, 0, 4, true)).rejects.toThrow(/cannot flush an active/);
    });
});
