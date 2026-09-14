import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createUniformBuffer } from "../../../packages/babylon-lite/src/resource/uniform-buffer";
import { createComputeTask } from "../../../packages/babylon-lite/src/compute/compute-task";
import { createComputeUniformArena } from "../../../packages/babylon-lite/src/compute/compute-uniform-arena";

function makeEngine(maxBufferSize = 1024) {
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => {
        const data = new ArrayBuffer(Number(descriptor.size));
        return { destroy: vi.fn(), getMappedRange: () => data, unmap: vi.fn() } as unknown as GPUBuffer;
    });
    const engine = {
        _device: {
            createBuffer,
            limits: { maxBufferSize, minUniformBufferOffsetAlignment: 256, maxUniformBufferBindingSize: 16 },
        },
    } as unknown as EngineContext;
    return { engine, createBuffer };
}

describe("uniform allocation boundaries", () => {
    it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid byte count %s", (size) => {
        const { engine, createBuffer } = makeEngine();
        expect(() => createUniformBuffer(engine, size)).toThrow(/non-negative safe integer/);
        expect(createBuffer).not.toHaveBeenCalled();
    });

    it("rejects oversized or unsafe aligned capacities before any CPU shadow is allocated", () => {
        const { engine, createBuffer } = makeEngine(31);
        const construct = vi.fn(() => {
            throw new Error("unexpected host allocation");
        });
        vi.stubGlobal("Uint8Array", new Proxy(Uint8Array, { construct }));
        try {
            for (const size of [17, 1024, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
                expect(() => createUniformBuffer(engine, size)).toThrow(/aligned byte length.*maxBufferSize/);
            }
            expect(construct).not.toHaveBeenCalled();
            expect(createBuffer).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it.each([
        [0, 16],
        [1, 16],
        [15, 16],
        [16, 16],
        [17, 32],
        [32, 32],
    ])("aligns %s valid bytes to %s", (size, capacity) => {
        const { engine, createBuffer } = makeEngine(capacity);
        const buffer = createUniformBuffer(engine, size);
        expect(buffer.byteLength).toBe(capacity);
        expect(buffer._data).toHaveLength(capacity);
        expect(createBuffer).toHaveBeenCalledWith(expect.objectContaining({ size: capacity }));
    });

    it("uses typed-view byte length and zero-pads its contents", () => {
        const { engine } = makeEngine(16);
        const source = new Uint8Array([99, 1, 2, 3, 99]);
        const buffer = createUniformBuffer(engine, source.subarray(1, 4));
        expect(Array.from(buffer._data!)).toEqual([1, 2, 3, ...new Array<number>(13).fill(0)]);
        expect(() => createUniformBuffer(engine, new Uint8Array(17))).toThrow(/maxBufferSize/);
    });
});

describe("uniform arena allocation boundaries", () => {
    it.each([
        [0, 1],
        [4.5, 1],
        [Infinity, 1],
        [Number.MAX_SAFE_INTEGER + 1, 1],
        [16, 0],
        [16, 1.5],
        [16, Infinity],
        [16, Number.MAX_SAFE_INTEGER + 1],
    ])("rejects invalid slot bytes/count %s/%s", (slotBytes, count) => {
        const { engine, createBuffer } = makeEngine();
        const task = createComputeTask(engine);
        expect(() => createComputeUniformArena(task, slotBytes, count)).toThrow(/positive safe integer/);
        expect(createBuffer).not.toHaveBeenCalled();
        expect(task._uniformArenas).toBeUndefined();
    });

    it.each([
        [Number.MAX_SAFE_INTEGER - 3, 1],
        [16, Number.MAX_SAFE_INTEGER],
    ])("rejects unsafe aligned stride/product %s/%s", (slotBytes, count) => {
        const { engine, createBuffer } = makeEngine();
        const task = createComputeTask(engine);
        expect(() => createComputeUniformArena(task, slotBytes, count)).toThrow(/stride and total byte length must be safe integers/);
        expect(createBuffer).not.toHaveBeenCalled();
        expect(task._uniformArenas).toBeUndefined();
    });

    it("validates total capacity but not the individual binding-size limit", () => {
        const { engine, createBuffer } = makeEngine(512);
        const task = createComputeTask(engine);
        const arena = createComputeUniformArena(task, 16, 2);
        expect(arena.slotStride).toBe(256);
        expect(arena.buffer.byteLength).toBe(512);
        expect(arena.buffer.byteLength).toBeGreaterThan(engine._device.limits.maxUniformBufferBindingSize);
        createBuffer.mockClear();
        expect(() => createComputeUniformArena(task, 16, 3)).toThrow(/maxBufferSize/);
        expect(createBuffer).not.toHaveBeenCalled();
        expect(task._uniformArenas).toEqual([arena]);
    });
});
