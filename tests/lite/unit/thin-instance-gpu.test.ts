import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { syncThinInstanceDrawArgs, syncThinInstanceForDraw, syncThinInstanceGpuData } from "../../../packages/babylon-lite/src/mesh/thin-instance-gpu";
import type { ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage"> & {
    GPUBufferUsage?: { VERTEX: number; COPY_DST: number; STORAGE: number; INDIRECT: number };
};
gpuGlobals.GPUBufferUsage ??= { VERTEX: 0x20, COPY_DST: 0x8, STORAGE: 0x80, INDIRECT: 0x100 } as unknown as GPUBufferUsage;

function makeThinInstances(count: number): ThinInstanceData {
    return {
        matrices: new Float32Array(count * 16),
        count,
        _capacity: count,
        _version: 1,
        _gpuBuffer: null,
        _gpuBufferStorage: false,
        _gpuVersion: 0,
        _dirtyMin: 0,
        _dirtyMax: count,
        _colorVersion: 0,
        _colorDirtyMin: 0,
        _colorDirtyMax: 0,
        _colorGpuBuffer: null,
        _colorGpuBufferStorage: false,
        _colorGpuVersion: 0,
        _gpuCullingEnabled: false,
    };
}

describe("thin-instance stable draw arguments", () => {
    it("queues replaced instance buffers for frame-gated retirement", () => {
        const oldMatrix = { size: 64, destroy: vi.fn() } as unknown as GPUBuffer;
        const oldColor = { size: 16, destroy: vi.fn() } as unknown as GPUBuffer;
        const newBuffers: GPUBuffer[] = [];
        const retirements: Array<() => void> = [];
        const engine = {
            _device: {
                createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
                    const buffer = { size: descriptor.size, destroy: vi.fn() } as unknown as GPUBuffer;
                    newBuffers.push(buffer);
                    return buffer;
                }),
                queue: {
                    writeBuffer: vi.fn(),
                },
            },
            _retirements: retirements,
        } as unknown as EngineContext;
        const ti = makeThinInstances(2);
        ti.colors = new Float32Array(8);
        ti._gpuBuffer = oldMatrix;
        ti._version = 2;
        ti._gpuVersion = 1;
        ti._colorGpuBuffer = oldColor;
        ti._colorVersion = 1;
        ti._colorGpuVersion = 0;

        syncThinInstanceGpuData(engine, ti, true);

        expect(newBuffers).toHaveLength(2);
        expect(retirements).toHaveLength(1);
        expect(oldMatrix.destroy).not.toHaveBeenCalled();
        expect(oldColor.destroy).not.toHaveBeenCalled();

        retirements[0]!();

        expect(oldMatrix.destroy).toHaveBeenCalledTimes(1);
        expect(oldColor.destroy).toHaveBeenCalledTimes(1);
    });

    it("keeps one indirect buffer while instance counts change", () => {
        const buffer = { destroy: vi.fn() } as unknown as GPUBuffer;
        const createBuffer = vi.fn(() => buffer);
        const writes: number[][] = [];
        const writeBuffer = vi.fn((_buffer: GPUBuffer, _offset: number, source: ArrayBuffer, sourceOffset: number, size: number) => {
            writes.push(Array.from(new Uint32Array(source, sourceOffset, size / 4)));
        });
        const engine = {
            _device: {
                createBuffer,
                queue: { writeBuffer },
            },
        } as unknown as EngineContext;
        const ti = makeThinInstances(12);

        const first = syncThinInstanceDrawArgs(engine, ti, 36);
        ti.count = 7;
        const second = syncThinInstanceDrawArgs(engine, ti, 36);
        syncThinInstanceDrawArgs(engine, ti, 36);

        expect(first).toBe(buffer);
        expect(second).toBe(buffer);
        expect(createBuffer).toHaveBeenCalledTimes(1);
        expect(writeBuffer).toHaveBeenCalledTimes(2);
        expect(writes).toEqual([
            [36, 12, 0, 0, 0],
            [36, 7, 0, 0, 0],
        ]);
    });

    it("keeps cached static draws direct until the instance count changes", () => {
        const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => ({ size: descriptor.size, destroy: vi.fn() }) as unknown as GPUBuffer);
        const engine = {
            _device: {
                createBuffer,
                queue: { writeBuffer: vi.fn() },
            },
        } as unknown as EngineContext;
        const ti = makeThinInstances(12);

        expect(syncThinInstanceForDraw(engine, ti, false, 36)).toBeNull();
        expect(syncThinInstanceForDraw(engine, ti, false, 36)).toBeNull();
        expect(ti._drawArgsBuffer).toBeFalsy();

        ti.count = 7;
        ti._version++;
        ti._dirtyMin = 0;
        ti._dirtyMax = ti.count;

        const indirect = syncThinInstanceForDraw(engine, ti, false, 36);
        expect(indirect).toBe(ti._drawArgsBuffer);
        expect(indirect).toBeTruthy();
        expect(syncThinInstanceForDraw(engine, ti, false, 36)).toBe(indirect);
    });
});
