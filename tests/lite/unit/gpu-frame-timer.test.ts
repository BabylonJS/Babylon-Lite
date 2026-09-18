import { describe, expect, it, vi } from "vitest";
import { createGpuFrameTimer, gpuFrameTimerBegin, gpuFrameTimerEnd, gpuFrameTimerResolve } from "../../../packages/babylon-lite/src/engine/gpu-timer";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage" | "GPUMapMode"> & {
    GPUBufferUsage?: { COPY_DST: number; COPY_SRC: number; MAP_READ: number; QUERY_RESOLVE: number };
    GPUMapMode?: { READ: number; WRITE: number };
};
gpuGlobals.GPUBufferUsage ??= { COPY_DST: 8, COPY_SRC: 4, MAP_READ: 1, QUERY_RESOLVE: 512 } as unknown as GPUBufferUsage;
gpuGlobals.GPUMapMode ??= { READ: 1, WRITE: 2 } as unknown as GPUMapMode;

function fixture() {
    const calls: unknown[] = [];
    const querySet = {} as GPUQuerySet;
    const pipeline = {} as GPUComputePipeline;
    const module = {} as GPUShaderModule;
    const createComputePipeline = vi.fn(() => pipeline);
    const createShaderModule = vi.fn(() => module);
    const encoder = {
        beginComputePass: (descriptor: GPUComputePassDescriptor) => {
            calls.push(descriptor.timestampWrites);
            return {
                setPipeline: (value: GPUComputePipeline) => calls.push(["pipeline", value]),
                dispatchWorkgroups: (count: number) => calls.push(["dispatch", count]),
                end: () => calls.push("end"),
            };
        },
    } as unknown as GPUCommandEncoder;
    const device = {
        features: new Set(["timestamp-query"]),
        createShaderModule,
        createComputePipeline,
        createQuerySet: () => querySet,
        createBuffer: () => ({}),
    } as unknown as GPUDevice;
    return { device, encoder, calls, querySet, pipeline, module, createComputePipeline, createShaderModule };
}

describe("GPU frame marker dispatch", () => {
    it("does not allocate a pipeline when timestamp queries are unsupported", () => {
        const f = fixture();
        (f.device.features as unknown as Set<string>).clear();
        expect(createGpuFrameTimer(f.device)).toBeNull();
        expect(f.createComputePipeline).not.toHaveBeenCalled();
        expect(f.createShaderModule).not.toHaveBeenCalled();
    });

    it("records one configured workgroup inside each marker and reuses the timer pipeline", () => {
        const f = fixture();
        const timer = createGpuFrameTimer(f.device)!;
        for (let frame = 0; frame < 2; frame++) {
            gpuFrameTimerBegin(timer, f.encoder);
            f.calls.push("payload");
            gpuFrameTimerEnd(timer, f.encoder);
        }
        expect(f.createShaderModule).toHaveBeenCalledExactlyOnceWith({ code: "@compute @workgroup_size(1) fn main() {}" });
        expect(f.createComputePipeline).toHaveBeenCalledExactlyOnceWith({ layout: "auto", compute: { module: f.module, entryPoint: "main" } });
        const frameCalls = [
            { querySet: f.querySet, beginningOfPassWriteIndex: 0 },
            ["pipeline", f.pipeline],
            ["dispatch", 1],
            "end",
            "payload",
            { querySet: f.querySet, endOfPassWriteIndex: 1 },
            ["pipeline", f.pipeline],
            ["dispatch", 1],
            "end",
        ];
        expect(f.calls).toEqual([...frameCalls, ...frameCalls]);
    });

    it("keeps readback asynchronous and publishes the resolved interval", async () => {
        const f = fixture();
        const timer = createGpuFrameTimer(f.device)!;
        let release!: () => void;
        const map = new Promise<void>((resolve) => {
            release = resolve;
        });
        const buffer = { mapAsync: () => map, getMappedRange: () => new BigInt64Array([2_000_000n, 5_000_000n]).buffer, unmap: vi.fn() } as unknown as GPUBuffer;
        timer.pool.push(buffer);
        Object.assign(f.device, {
            createCommandEncoder: () => ({ resolveQuerySet: vi.fn(), copyBufferToBuffer: vi.fn(), finish: vi.fn() }),
            queue: { submit: vi.fn() },
        });
        gpuFrameTimerResolve(timer);
        expect(timer.lastMs).toBe(0);
        expect(timer.inFlight).toBe(1);
        release();
        await map;
        expect(timer.lastMs).toBe(3);
        expect(timer.inFlight).toBe(0);
        expect(timer.pool).toEqual([buffer]);
        expect(f.createComputePipeline).toHaveBeenCalledOnce();
    });
});
