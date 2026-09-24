import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { disposeGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import { enableDrawBatchCollection } from "../../../packages/babylon-lite/src/render/draw-update-batches";
import { getUniformCopyBatch } from "../../../packages/babylon-lite/src/render/uniform-copy-batch";
import type { DrawBinding, DrawUpdateBatch, Renderable } from "../../../packages/babylon-lite/src/render/renderable";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage"> & {
    GPUBufferUsage?: { COPY_SRC: number; COPY_DST: number };
};
gpuGlobals.GPUBufferUsage ??= { COPY_SRC: 0x4, COPY_DST: 0x8 } as unknown as GPUBufferUsage;

function makeDevice(maxBufferSize = Number.MAX_SAFE_INTEGER, maxUniformBufferBindingSize = Number.MAX_SAFE_INTEGER) {
    const buffers: GPUBuffer[] = [];
    const device = {
        limits: { maxBufferSize, maxUniformBufferBindingSize },
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            if (descriptor.size > maxBufferSize) {
                throw new Error(`Buffer size ${descriptor.size} exceeds maxBufferSize ${maxBufferSize}.`);
            }
            const buffer = { size: descriptor.size, destroy: vi.fn() } as unknown as GPUBuffer;
            buffers.push(buffer);
            return buffer;
        }),
        queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    return { device, buffers };
}

function binding(batch: DrawUpdateBatch): DrawBinding {
    return {
        renderable: {} as Renderable,
        pipeline: {} as GPURenderPipeline,
        draw: () => 0,
        _updateBatches: [batch],
    };
}

describe("uniform copy batching", () => {
    it("reuses immutable uniform-only state without aliasing binding arrays", () => {
        const signature = {} as RenderTargetSignature;
        const batch = getUniformCopyBatch(signature);
        const input = [batch];
        const binding: DrawBinding = {
            renderable: {} as Renderable,
            pipeline: {} as GPURenderPipeline,
            draw: () => 0,
            _updateBatches: input,
        };
        const state = signature._collectBatches!(undefined, binding)!;
        expect(signature._collectBatches!(undefined, binding)).toBe(state);

        input.length = 0;

        expect(state._batches).toEqual([batch]);
        expect(state._select([[binding]])).toBeUndefined();
    });

    it("retires a specialized batch only after every retained task releases it", () => {
        const signature = {} as RenderTargetSignature;
        const batch = getUniformCopyBatch(signature);
        const drawBinding = binding(batch);
        const first = signature._collectBatches!(undefined, drawBinding)!;
        const second = first._select([[drawBinding]])!;
        const destroy = vi.spyOn(batch, "destroy");
        const engine = {} as EngineContext;

        first._release(engine, [undefined, second]);
        disposeGpuResourceRetirements(engine);
        expect(destroy).not.toHaveBeenCalled();

        second._release(engine, [undefined]);
        expect(destroy).not.toHaveBeenCalled();
        disposeGpuResourceRetirements(engine);
        expect(destroy).toHaveBeenCalledOnce();
    });

    it("installs a fresh collector after candidate rollback", () => {
        const signature = {} as RenderTargetSignature;
        const first = getUniformCopyBatch(signature);
        const state = signature._collectBatches!(undefined, binding(first))!;

        state._release();
        const second = getUniformCopyBatch(signature);

        expect(second).not.toBe(first);
        expect(signature._collectBatches!(undefined, binding(second))?._batches).toEqual([second]);
    });

    it("reactivates after fenced disposal", () => {
        const signature = {} as RenderTargetSignature;
        const first = getUniformCopyBatch(signature);
        const state = signature._collectBatches!(undefined, binding(first))!;
        const engine = {} as EngineContext;

        state._release(engine);
        disposeGpuResourceRetirements(engine);
        const second = getUniformCopyBatch(signature);

        expect(second).not.toBe(first);
        expect(signature._collectBatches!(undefined, binding(second))?._batches).toEqual([second]);
    });

    it("does not return a batch already scheduled for fenced disposal", () => {
        const signature = {} as RenderTargetSignature;
        const first = getUniformCopyBatch(signature);
        const state = signature._collectBatches!(undefined, binding(first))!;
        const engine = {} as EngineContext;

        state._release(engine);
        const second = getUniformCopyBatch(signature);
        const secondCollector = signature._collectBatches;
        disposeGpuResourceRetirements(engine);

        expect(second).not.toBe(first);
        expect(getUniformCopyBatch(signature)).toBe(second);
        expect(signature._collectBatches).toBe(secondCollector);
        expect(secondCollector!(undefined, binding(second))?._batches).toEqual([second]);
    });

    it("repeated old disposal cannot evict a replacement generation", () => {
        const signature = {} as RenderTargetSignature;
        const first = getUniformCopyBatch(signature);
        signature._collectBatches!(undefined, binding(first))!._release();
        const second = getUniformCopyBatch(signature);
        const secondCollector = signature._collectBatches;

        first.destroy();
        first.destroy();

        expect(getUniformCopyBatch(signature)).toBe(second);
        expect(signature._collectBatches).toBe(secondCollector);
    });

    it("recreates a directly destroyed batch with working collection and uploads", () => {
        const signature: RenderTargetSignature = { _sampleCount: 1 };
        const first = getUniformCopyBatch(signature);
        first.destroy();
        const second = getUniformCopyBatch(signature);
        const state = signature._collectBatches!(undefined, binding(second))!;
        const { device } = makeDevice();
        const encoder = { copyBufferToBuffer: vi.fn() } as unknown as GPUCommandEncoder;
        const engine = { _device: device, _currentEncoder: encoder } as unknown as EngineContext;
        const destination = {} as GPUBuffer;
        const data = new Float32Array([1, 2, 3, 4]);

        first.destroy();
        state._reset();
        second.queue(destination, data);
        state._flush(engine);

        expect(second).not.toBe(first);
        expect(getUniformCopyBatch(signature)).toBe(second);
        expect(state._batches).toEqual([second]);
        expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
        expect(encoder.copyBufferToBuffer).toHaveBeenCalledWith(expect.anything(), 0, destination, 0, data.byteLength);
        second.destroy();
    });

    it("preserves a promoted generic collector while recreating a retired uniform batch", () => {
        const signature = {} as RenderTargetSignature;
        const first = getUniformCopyBatch(signature);
        const firstState = signature._collectBatches!(undefined, binding(first))!;
        const compute = { reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() };
        enableDrawBatchCollection(signature);
        const genericCollector = signature._collectBatches;
        const promoted = genericCollector!(firstState, binding(compute))!;
        const retainedCompute = promoted._select([[binding(compute)]])!;
        const engine = {} as EngineContext;

        promoted._release(engine, [retainedCompute]);
        const second = getUniformCopyBatch(signature);
        disposeGpuResourceRetirements(engine);

        expect(second).not.toBe(first);
        expect(signature._collectBatches).toBe(genericCollector);
        expect(genericCollector!(undefined, binding(second))?._batches).toEqual([second]);
        expect(compute.destroy).not.toHaveBeenCalled();
    });

    it("preserves published uniform-only state when a promoted candidate rolls back", () => {
        const signature: RenderTargetSignature = { _sampleCount: 1 };
        const uniform = getUniformCopyBatch(signature);
        const published = signature._collectBatches!(undefined, binding(uniform))!;
        const compute = { reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() };
        enableDrawBatchCollection(signature);
        const candidate = signature._collectBatches!(published, binding(compute))!;

        candidate._release(undefined, [published]);

        expect(compute.destroy).toHaveBeenCalledOnce();
        expect(uniform._retired).toBe(false);
        expect(published._batches).toEqual([uniform]);
        expect(published._reset).toBe(uniform.reset);
        expect(getUniformCopyBatch(signature)).toBe(uniform);
        published._release();
    });

    it("reuses the byte view while the queued staging array is unchanged", () => {
        const signature = {} as RenderTargetSignature;
        const batch = getUniformCopyBatch(signature);
        const { device } = makeDevice();
        const encoder = { copyBufferToBuffer: vi.fn() } as unknown as GPUCommandEncoder;
        const engine = { _device: device, _currentEncoder: encoder } as unknown as EngineContext;
        const destination = {} as GPUBuffer;
        const data = new Float32Array([1, 2, 3, 4]);

        batch.queue(destination, data);
        batch.flush(engine);
        const firstView = batch._copies[0]!._u8;
        batch.reset();
        data[0] = 5;
        batch.queue(destination, data);
        batch.flush(engine);

        expect(batch._copies[0]!._u8).toBe(firstView);
        batch.reset();
        batch.queue(destination, new Float32Array([6, 7, 8, 9]));
        batch.flush(engine);
        expect(batch._copies[0]!._u8).not.toBe(firstView);
        batch.destroy();
    });

    it("packs live uniform contents at the queued offsets and resets its byte budget", () => {
        const batch = getUniformCopyBatch({ _sampleCount: 1 });
        const { device, buffers } = makeDevice();
        const encoder = { copyBufferToBuffer: vi.fn() } as unknown as GPUCommandEncoder;
        const engine = { _device: device, _currentEncoder: encoder } as unknown as EngineContext;
        const firstTarget = {} as GPUBuffer;
        const secondTarget = {} as GPUBuffer;
        const first = new Float32Array([1, 2, 3, 4]);
        const second = new Float32Array([5, 6]);
        batch.queue(firstTarget, first, 8);
        batch.queue(secondTarget, second);
        first[0] = 9;

        batch.flush(engine);

        const upload = vi.mocked(device.queue.writeBuffer).mock.calls[0]!;
        expect(upload[4]).toBe(24);
        expect(Array.from(new Float32Array(upload[2] as ArrayBuffer, upload[3], 6))).toEqual([9, 2, 3, 4, 5, 6]);
        expect(encoder.copyBufferToBuffer).toHaveBeenNthCalledWith(1, buffers[0], 0, firstTarget, 8, 16);
        expect(encoder.copyBufferToBuffer).toHaveBeenNthCalledWith(2, buffers[0], 16, secondTarget, 0, 8);

        batch.reset();
        batch.queue(secondTarget, second);
        batch.flush(engine);
        expect(vi.mocked(device.queue.writeBuffer).mock.calls[1]![4]).toBe(8);
        expect(encoder.copyBufferToBuffer).toHaveBeenLastCalledWith(buffers[0], 0, secondTarget, 0, 8);
        batch.reset();
        batch.queue(secondTarget, second);
        batch.queue(firstTarget, first, 8);
        batch.flush(engine);
        const reversedUpload = vi.mocked(device.queue.writeBuffer).mock.calls[2]!;
        expect(Array.from(new Float32Array(reversedUpload[2] as ArrayBuffer, reversedUpload[3], 6))).toEqual([5, 6, 9, 2, 3, 4]);
        expect(encoder.copyBufferToBuffer).toHaveBeenLastCalledWith(buffers[0], 8, firstTarget, 8, 16);
        batch.destroy();
    });

    it.each([
        [new Uint8Array(3), 0],
        [new Uint8Array(4), 2],
    ] as const)("rejects misaligned copies before changing the pending batch", (invalidData, invalidOffset) => {
        const batch = getUniformCopyBatch({ _sampleCount: 1 });
        const { device } = makeDevice();
        const encoder = { copyBufferToBuffer: vi.fn() } as unknown as GPUCommandEncoder;
        const engine = { _device: device, _currentEncoder: encoder } as unknown as EngineContext;
        const target = {} as GPUBuffer;
        batch.queue(target, new Uint8Array(4));

        expect(() => batch.queue(target, invalidData, invalidOffset)).toThrow(/4-byte-aligned/);
        batch.queue(target, new Uint8Array(8));
        batch.flush(engine);

        expect(batch._copies).toHaveLength(2);
        expect(encoder.copyBufferToBuffer).toHaveBeenCalledTimes(2);
        expect(vi.mocked(device.queue.writeBuffer).mock.calls[0]![4]).toBe(12);
        batch.destroy();
    });

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

    it("does not carry staging capacity onto a replacement device with smaller limits", () => {
        const signature = {} as RenderTargetSignature;
        const batch = getUniformCopyBatch(signature);
        const first = makeDevice(2048, 1024);
        const second = makeDevice(256, 64);
        const destination = {} as GPUBuffer;

        batch.queue(destination, new Uint8Array(1024));
        batch.flush({ _device: first.device, _currentEncoder: { copyBufferToBuffer: vi.fn() } } as unknown as EngineContext);
        expect(first.buffers[0]!.size).toBe(1024);

        batch.reset();
        batch.queue(destination, new Uint8Array(16));
        batch.flush({ _device: second.device, _currentEncoder: { copyBufferToBuffer: vi.fn() } } as unknown as EngineContext);

        expect(second.buffers[0]!.size).toBe(256);
        expect(second.device.createBuffer).toHaveBeenCalledWith(expect.objectContaining({ size: 256 }));
        batch.destroy();
    });
});
