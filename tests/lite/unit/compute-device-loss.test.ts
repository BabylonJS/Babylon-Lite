import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createComputeShader, dispatchCompute, setComputeStorageBuffer, setComputeUniform } from "../../../packages/babylon-lite/src/compute/compute-shader";
import { createStorageBuffer, _rebuildStorageBuffers } from "../../../packages/babylon-lite/src/resource/storage-buffer";

function makeDevice(tag: string) {
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() } as unknown as GPUComputePassEncoder;
    return {
        _tag: tag,
        createShaderModule: vi.fn((d: GPUShaderModuleDescriptor) => d as unknown as GPUShaderModule),
        createBindGroupLayout: vi.fn(() => ({ _tag: tag }) as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn(() => ({ _tag: tag }) as unknown as GPUPipelineLayout),
        createComputePipeline: vi.fn(() => ({ _tag: tag }) as unknown as GPUComputePipeline),
        createBindGroup: vi.fn((d: GPUBindGroupDescriptor) => ({ _tag: tag, entries: d.entries }) as unknown as GPUBindGroup),
        createBuffer: vi.fn((d: GPUBufferDescriptor) => {
            const backing = new ArrayBuffer(Number(d.size));
            return {
                _tag: tag,
                label: d.label,
                size: Number(d.size),
                usage: Number(d.usage),
                getMappedRange: () => backing,
                unmap: vi.fn(),
                destroy: vi.fn(),
            } as unknown as GPUBuffer;
        }),
        createCommandEncoder: vi.fn(() => ({ beginComputePass: () => pass, finish: () => ({}) as GPUCommandBuffer }) as unknown as GPUCommandEncoder),
        queue: { writeBuffer: vi.fn(), submit: vi.fn() },
        limits: {},
    };
}

const SOURCE = `@compute @workgroup_size(64) fn main() { }`;

function setup() {
    const first = makeDevice("first");
    const engine = { _device: first, _disposables: [] } as unknown as EngineContext;
    const shader = createComputeShader(engine, {
        name: "fill",
        computeSource: SOURCE,
        uniforms: [{ name: "span", type: "f32" as const }],
        storageBuffers: [{ name: "out", type: "array<f32>", writable: true }],
    });
    const target = createStorageBuffer(engine, 256, { writable: true });
    setComputeStorageBuffer(shader, "out", target);
    setComputeUniform(shader, "span", 4);
    dispatchCompute(engine, shader, 1);
    return { engine, shader, target, first };
}

/** Replace the device the way device-lost recovery does, then rebuild allocations. */
function loseDevice(engine: EngineContext, tag: string) {
    const next = makeDevice(tag);
    (engine as unknown as { _device: unknown })._device = next;
    _rebuildStorageBuffers(engine);
    return next;
}

describe("compute programs survive a device loss", () => {
    it("recreates pipeline, layout and bind group against the replacement device", () => {
        const { engine, shader, first } = setup();
        expect((shader._pipeline as unknown as { _tag: string })._tag).toBe("first");

        const second = loseDevice(engine, "second");
        dispatchCompute(engine, shader, 1);

        // Every cached object was created against the dead device; using any of them
        // after recovery is an error, and nothing invalidated them before.
        expect((shader._pipeline as unknown as { _tag: string })._tag).toBe("second");
        expect((shader._layout as unknown as { _tag: string })._tag).toBe("second");
        expect((shader._bindGroup as unknown as { _tag: string })._tag).toBe("second");
        expect(second.createComputePipeline).toHaveBeenCalledTimes(1);
        expect(first.createComputePipeline).toHaveBeenCalledTimes(1);
    });

    it("reallocates the uniform buffer and re-uploads the values already set", () => {
        const { engine, shader } = setup();
        const second = loseDevice(engine, "second");

        dispatchCompute(engine, shader, 1);

        expect((shader._uboBuffer as unknown as { _tag: string })._tag).toBe("second");
        // The uniform DATA lives in a CPU ArrayBuffer and survives, so the value the
        // caller set before the loss must reach the new buffer without being set again.
        expect(second.queue.writeBuffer).toHaveBeenCalled();
        const [buffer, offset] = second.queue.writeBuffer.mock.calls[0]!;
        expect((buffer as { _tag: string })._tag).toBe("second");
        expect(offset).toBe(0);
    });

    it("binds the rebuilt storage allocation, not the dead handle", () => {
        const { engine, shader, target } = setup();
        loseDevice(engine, "second");
        dispatchCompute(engine, shader, 1);

        const entries = (shader._bindGroup as unknown as { entries: { resource: { buffer: unknown } }[] }).entries;
        const bound = entries[entries.length - 1]!.resource.buffer;
        expect(bound).toBe(target._buffer);
        expect((bound as { _tag: string })._tag).toBe("second");
    });

    it("does no work when the device has not changed", () => {
        const { engine, shader, first } = setup();
        const pipeline = shader._pipeline;
        dispatchCompute(engine, shader, 1);
        expect(shader._pipeline).toBe(pipeline);
        expect(first.createComputePipeline).toHaveBeenCalledTimes(1);
    });
});
