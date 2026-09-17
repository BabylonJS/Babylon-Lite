import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import { syncThinInstanceDrawArgs, syncThinInstanceForDraw, syncThinInstanceGpuData } from "../../../packages/babylon-lite/src/mesh/thin-instance-gpu";
import {
    enableThinInstanceDynamicDrawCount,
    enableThinInstanceGpuCulling,
    setThinInstanceCount,
    setThinInstanceDrawCount,
    setThinInstanceMatrix,
    type ThinInstanceData,
} from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";

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

function makeGpu(baseVertex = 0): Mesh["_gpu"] {
    return { indexCount: 36, _baseVertex: baseVertex } as Mesh["_gpu"];
}

describe("thin-instance stable draw arguments", () => {
    it("does not recreate or re-upload storage-capable matrices when GPU culling changes", () => {
        const matrix = { size: 128 } as GPUBuffer;
        const color = { size: 32, destroy: vi.fn() } as unknown as GPUBuffer;
        const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => ({ size: descriptor.size, destroy: vi.fn() }) as unknown as GPUBuffer);
        const engine = { _device: { createBuffer, queue: { writeBuffer: vi.fn() } }, _retirements: [] } as unknown as EngineContext;
        const ti = makeThinInstances(2);
        ti._gpuBuffer = matrix;
        ti._gpuVersion = ti._version;
        ti._dirtyMin = ti.count;
        ti._dirtyMax = 0;
        enableThinInstanceGpuCulling({ thinInstances: ti } as Mesh);

        expect(syncThinInstanceGpuData(engine, ti, false)).toBe(false);
        expect(ti._gpuBuffer).toBe(matrix);
        expect(createBuffer).not.toHaveBeenCalled();
        expect(engine._device.queue.writeBuffer).not.toHaveBeenCalled();

        ti.colors = new Float32Array(8);
        ti._colorGpuBuffer = color;
        ti._colorVersion = ti._colorGpuVersion = 1;
        expect(syncThinInstanceGpuData(engine, ti, true)).toBe(true);
        expect(ti._gpuBuffer).toBe(matrix);
        expect(createBuffer).toHaveBeenCalledOnce();
        expect(createBuffer).toHaveBeenCalledWith(expect.objectContaining({ label: "thin-instance-colors", usage: 0xa8 }));
    });

    it("uses the argument snapshot for signed base vertices, index changes and zero-initialized generations", () => {
        const writes: number[][] = [];
        const engine = {
            _device: {
                createBuffer: vi.fn(() => ({})),
                queue: {
                    writeBuffer: vi.fn((_buffer: GPUBuffer, _offset: number, data: ArrayBuffer, byteOffset: number, byteLength: number) => {
                        writes.push(Array.from(new Uint32Array(data, byteOffset, byteLength / 4)));
                    }),
                },
            },
        } as unknown as EngineContext;
        const ti = makeThinInstances(0);
        const empty = { indexCount: 0, _baseVertex: 0 } as Mesh["_gpu"];
        syncThinInstanceDrawArgs(engine, ti, empty);
        expect(writes).toEqual([[0, 0, 0, 0, 0]]);

        const gpu = makeGpu(-12);
        ti.count = 3;
        syncThinInstanceDrawArgs(engine, ti, gpu);
        syncThinInstanceDrawArgs(engine, ti, gpu);
        expect(writes).toEqual([
            [0, 0, 0, 0, 0],
            [36, 3, 0, 0xfffffff4, 0],
        ]);
        syncThinInstanceDrawArgs(engine, ti, { ...gpu, indexCount: 12 });
        expect(writes[2]).toEqual([12, 3, 0, 0xfffffff4, 0]);
        syncThinInstanceDrawArgs(engine, ti, makeGpu(12));
        expect(writes[3]).toEqual([36, 3, 0, 12, 0]);

        ti._drawArgsBuffer = undefined;
        syncThinInstanceDrawArgs(engine, ti, gpu);
        expect(writes[4]).toEqual([36, 3, 0, 0xfffffff4, 0]);
        expect(engine._device.createBuffer).toHaveBeenCalledTimes(2);
    });

    it("retries a failed argument upload even when its CPU words already match", () => {
        const writeBuffer = vi.fn();
        const engine = { _device: { createBuffer: vi.fn(() => ({})), queue: { writeBuffer } } } as unknown as EngineContext;
        const ti = makeThinInstances(3);
        syncThinInstanceDrawArgs(engine, ti, makeGpu(0));
        writeBuffer.mockImplementationOnce(() => {
            throw new Error("upload failed");
        });
        expect(() => syncThinInstanceDrawArgs(engine, ti, makeGpu(8))).toThrow("upload failed");
        syncThinInstanceDrawArgs(engine, ti, makeGpu(8));
        syncThinInstanceDrawArgs(engine, ti, makeGpu(8));
        expect(writeBuffer).toHaveBeenCalledTimes(3);
        expect(Array.from(ti._drawArgsData!)).toEqual([36, 3, 0, 8, 0]);
    });

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

        const gpu = makeGpu();
        const first = syncThinInstanceDrawArgs(engine, ti, gpu);
        ti.count = 7;
        const second = syncThinInstanceDrawArgs(engine, ti, gpu);
        syncThinInstanceDrawArgs(engine, ti, gpu);

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
        const gpu = makeGpu();

        expect(syncThinInstanceForDraw(engine, ti, false, gpu)).toBeNull();
        expect(syncThinInstanceForDraw(engine, ti, false, gpu)).toBeNull();
        expect(ti._drawArgsBuffer).toBeFalsy();

        ti.count = 7;
        ti._version++;
        ti._dirtyMin = 0;
        ti._dirtyMax = ti.count;

        const indirect = syncThinInstanceForDraw(engine, ti, false, gpu);
        expect(indirect).toBe(ti._drawArgsBuffer);
        expect(indirect).toBeTruthy();
        expect(syncThinInstanceForDraw(engine, ti, false, gpu)).toBe(indirect);
    });

    it("updates only draw arguments when the count-only setter changes the active prefix", () => {
        const matrixBuffer = { size: 12 * 64, destroy: vi.fn() } as unknown as GPUBuffer;
        const indirectBuffer = { size: 20, destroy: vi.fn() } as unknown as GPUBuffer;
        const writeBuffer = vi.fn();
        const engine = {
            _device: {
                createBuffer: vi.fn(() => indirectBuffer),
                queue: { writeBuffer },
            },
        } as unknown as EngineContext;
        const ti = makeThinInstances(12);
        ti._gpuBuffer = matrixBuffer;
        ti._gpuVersion = ti._version;
        ti._dirtyMin = 12;
        ti._dirtyMax = 0;
        const mesh = { thinInstances: ti, _gpu: makeGpu() } as unknown as Mesh;

        expect(syncThinInstanceForDraw(engine, ti, false, mesh._gpu)).toBeNull();
        setThinInstanceDrawCount(mesh, 7);

        expect(ti.count).toBe(7);
        expect(ti._version).toBe(2);
        expect(ti._dirtyMin).toBe(12);
        expect(ti._dirtyMax).toBe(0);
        expect(syncThinInstanceForDraw(engine, ti, false, mesh._gpu)).toBe(indirectBuffer);
        expect(writeBuffer).toHaveBeenCalledTimes(1);
    });

    it("supports consecutive count-only changes before the next draw", () => {
        const ti = makeThinInstances(12);
        ti._gpuBuffer = { size: 12 * 64 } as GPUBuffer;
        ti._gpuVersion = ti._version;
        const mesh = { thinInstances: ti, _gpu: makeGpu() } as unknown as Mesh;

        setThinInstanceDrawCount(mesh, 7);
        setThinInstanceDrawCount(mesh, 9);

        expect(ti.count).toBe(9);
        expect(ti._gpuVersion).toBe(ti._version);
        expect(ti._dirtyMin).toBe(0);
        expect(ti._dirtyMax).toBe(12);
    });

    it("creates stable indirect args during warm-up when explicitly enabled", () => {
        const indirectBuffer = { size: 20 } as GPUBuffer;
        const engine = {
            _device: {
                createBuffer: vi.fn(() => indirectBuffer),
                queue: { writeBuffer: vi.fn() },
            },
        } as unknown as EngineContext;
        const ti = makeThinInstances(4);
        ti._gpuBuffer = { size: 4 * 64 } as GPUBuffer;
        ti._gpuVersion = ti._version;
        const mesh = { thinInstances: ti, _gpu: makeGpu() } as unknown as Mesh;

        enableThinInstanceDynamicDrawCount(mesh);
        const args = syncThinInstanceForDraw(engine, ti, false, mesh._gpu);

        expect(args).toBe(indirectBuffer);
        expect(ti._drawArgsBuffer).toBe(indirectBuffer);
        expect(engine._device.queue.writeBuffer).toHaveBeenCalledTimes(1);
    });

    it("rejects dynamic draw-count warm-up without thin instances", () => {
        expect(() => enableThinInstanceDynamicDrawCount({} as Mesh)).toThrow("requires mesh.thinInstances");
    });

    it("keeps ordinary count changes dirty until matrices upload", () => {
        const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => ({ size: descriptor.size, destroy: vi.fn() }) as unknown as GPUBuffer);
        const writeBuffer = vi.fn();
        const engine = {
            _device: {
                createBuffer,
                queue: { writeBuffer },
            },
        } as unknown as EngineContext;
        const ti = makeThinInstances(2);
        const mesh = { thinInstances: ti, _gpu: makeGpu() } as unknown as Mesh;

        setThinInstanceCount(mesh, 0);
        setThinInstanceMatrix(mesh, 0, new Float32Array(16) as unknown as Mat4);
        setThinInstanceCount(mesh, 1);
        syncThinInstanceGpuData(engine, ti, false);

        expect(createBuffer).toHaveBeenCalledTimes(1);
        expect(writeBuffer).toHaveBeenCalledTimes(1);
        expect(ti._gpuVersion).toBe(ti._version);
    });

    it("rejects count changes before the fixed-capacity pool has synchronized", () => {
        const ti = makeThinInstances(12);
        const mesh = { thinInstances: ti } as unknown as Mesh;

        expect(() => setThinInstanceDrawCount(mesh, 7)).toThrow("fully synchronized fixed-capacity pool");
        expect(ti.count).toBe(12);
        expect(ti._version).toBe(1);
    });

    it("rejects count-only draw counts outside the established capacity", () => {
        const mesh = { thinInstances: makeThinInstances(12) } as unknown as Mesh;

        expect(() => setThinInstanceDrawCount(mesh, -1)).toThrow(RangeError);
        expect(() => setThinInstanceDrawCount(mesh, 13)).toThrow(RangeError);
        expect(() => setThinInstanceDrawCount(mesh, 1.5)).toThrow(RangeError);
        expect(mesh.thinInstances!.count).toBe(12);
    });

    it("does not invalidate draw or shadow state when the count is unchanged", () => {
        const ti = makeThinInstances(12);
        const mesh = { thinInstances: ti, _gpu: {} as Mesh["_gpu"] } as unknown as Mesh;

        setThinInstanceDrawCount(mesh, 12);

        expect(ti.count).toBe(12);
        expect(ti._version).toBe(1);
        expect(ti._dirtyMin).toBe(0);
        expect(ti._dirtyMax).toBe(12);
    });
});
