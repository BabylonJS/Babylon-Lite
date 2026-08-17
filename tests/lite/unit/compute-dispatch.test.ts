import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createComputeShader, setComputeStorageBuffer, setComputeUniform, dispatchCompute, disposeComputeShader } from "../../../packages/babylon-lite/src/compute/compute-shader";
import { createStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";

interface Recorder {
    submits: number;
    encoders: number;
    setPipeline: ReturnType<typeof vi.fn>;
    setBindGroup: ReturnType<typeof vi.fn>;
    dispatchWorkgroups: ReturnType<typeof vi.fn>;
    createComputePipeline: ReturnType<typeof vi.fn>;
    createBindGroup: ReturnType<typeof vi.fn>;
    writeBuffer: ReturnType<typeof vi.fn>;
}

function makeEngine(): { engine: EngineContext; rec: Recorder } {
    const rec: Partial<Recorder> = { submits: 0, encoders: 0 };
    rec.setPipeline = vi.fn();
    rec.setBindGroup = vi.fn();
    rec.dispatchWorkgroups = vi.fn();
    rec.writeBuffer = vi.fn();
    rec.createComputePipeline = vi.fn((d: GPUComputePipelineDescriptor) => ({ label: d.label }) as unknown as GPUComputePipeline);
    rec.createBindGroup = vi.fn((d: GPUBindGroupDescriptor) => ({ ...d }) as unknown as GPUBindGroup);
    const pass = {
        setPipeline: rec.setPipeline,
        setBindGroup: rec.setBindGroup,
        dispatchWorkgroups: rec.dispatchWorkgroups,
        end: vi.fn(),
    } as unknown as GPUComputePassEncoder;
    const makeEncoder = (): GPUCommandEncoder => {
        rec.encoders!++;
        return { beginComputePass: () => pass, finish: () => ({}) as GPUCommandBuffer } as unknown as GPUCommandEncoder;
    };
    const device = {
        createShaderModule: vi.fn((d: GPUShaderModuleDescriptor) => d as unknown as GPUShaderModule),
        createBindGroupLayout: vi.fn((d: GPUBindGroupLayoutDescriptor) => d as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((d: GPUPipelineLayoutDescriptor) => d as unknown as GPUPipelineLayout),
        createComputePipeline: rec.createComputePipeline,
        createBindGroup: rec.createBindGroup,
        createBuffer: vi.fn((d: GPUBufferDescriptor) => {
            const backing = new ArrayBuffer(Number(d.size));
            return { label: d.label, size: Number(d.size), getMappedRange: () => backing, unmap: vi.fn(), destroy: vi.fn() } as unknown as GPUBuffer;
        }),
        createCommandEncoder: vi.fn(makeEncoder),
        queue: {
            writeBuffer: rec.writeBuffer,
            submit: vi.fn(() => {
                rec.submits!++;
            }),
        },
    } as unknown as GPUDevice;
    const engine = { _device: device, _disposables: [] } as unknown as EngineContext;
    return { engine, rec: rec as Recorder };
}

const SOURCE = `@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3<u32>) { out[gid.x] = params[gid.x]; }`;

function makeShader(engine: EngineContext, uniforms?: boolean) {
    return createComputeShader(engine, {
        name: "fill",
        computeSource: SOURCE,
        ...(uniforms ? { uniforms: [{ name: "span", type: "f32" as const }] } : {}),
        storageBuffers: [
            { name: "params", type: "array<f32>" },
            { name: "out", type: "array<f32>", writable: true },
        ],
    });
}

function bindBoth(engine: EngineContext, shader: ReturnType<typeof makeShader>, slab = createStorageBuffer(engine, 256, { writable: true })): void {
    setComputeStorageBuffer(shader, "params", createStorageBuffer(engine, new Float32Array(4)));
    setComputeStorageBuffer(shader, "out", slab);
}

describe("dispatchCompute", () => {
    it("re-binding storage between dispatches gives each dispatch its own bind group", () => {
        const { engine, rec } = makeEngine();
        const shader = makeShader(engine);
        const slab = createStorageBuffer(engine, 256, { writable: true });
        setComputeStorageBuffer(shader, "out", slab);

        for (const label of ["a", "b", "c"]) {
            setComputeStorageBuffer(shader, "params", createStorageBuffer(engine, new Float32Array(4), { label }));
            dispatchCompute(engine, shader, 4);
        }

        // One program, three data sets: the pipeline is built once, the bind group thrice.
        expect(rec.createComputePipeline).toHaveBeenCalledTimes(1);
        expect(rec.setBindGroup).toHaveBeenCalledTimes(3);
        expect(new Set(rec.setBindGroup.mock.calls.map((c) => c[1])).size).toBe(3);
    });

    it("gives each dispatch its own encoder and submission", () => {
        const { engine, rec } = makeEngine();
        const shader = makeShader(engine);
        bindBoth(engine, shader);

        dispatchCompute(engine, shader, 1);
        dispatchCompute(engine, shader, 1);

        expect(rec.encoders).toBe(2);
        expect(rec.submits).toBe(2);
    });

    it("passes the workgroup counts through unchanged", () => {
        const { engine, rec } = makeEngine();
        const shader = makeShader(engine);
        bindBoth(engine, shader);
        dispatchCompute(engine, shader, 4, 2, 3);
        expect(rec.dispatchWorkgroups.mock.calls).toEqual([[4, 2, 3]]);
    });

    it("a uniform changed between dispatches reaches the GPU once per dispatch", () => {
        const { engine, rec } = makeEngine();
        const shader = makeShader(engine, true);
        bindBoth(engine, shader);

        // Correct only because each dispatch is its own submission: queue.writeBuffer is
        // ordered against submission, so batching these would collapse both onto the
        // second value. See the module header.
        setComputeUniform(shader, "span", 1);
        dispatchCompute(engine, shader, 1);
        setComputeUniform(shader, "span", 2);
        dispatchCompute(engine, shader, 1);

        expect(rec.writeBuffer).toHaveBeenCalledTimes(2);
        expect(rec.submits).toBe(2);
    });

    it("does not rewrite the uniform buffer when nothing changed", () => {
        const { engine, rec } = makeEngine();
        const shader = makeShader(engine, true);
        bindBoth(engine, shader);
        setComputeUniform(shader, "span", 1);
        dispatchCompute(engine, shader, 1);
        dispatchCompute(engine, shader, 1);
        expect(rec.writeBuffer).toHaveBeenCalledTimes(1);
    });

    it("names the missing binding rather than dispatching a partial set", () => {
        const { engine } = makeEngine();
        const shader = makeShader(engine);
        setComputeStorageBuffer(shader, "params", createStorageBuffer(engine, new Float32Array(4)));
        expect(() => dispatchCompute(engine, shader, 1)).toThrow(/"out" was declared but never bound/);
    });

    it("rejects a read-only allocation on a read_write binding", () => {
        const { engine } = makeEngine();
        const shader = makeShader(engine);
        expect(() => setComputeStorageBuffer(shader, "out", createStorageBuffer(engine, 256))).toThrow(/writable: true/);
    });

    it("rejects non-positive workgroup counts", () => {
        const { engine } = makeEngine();
        const shader = makeShader(engine);
        bindBoth(engine, shader);
        expect(() => dispatchCompute(engine, shader, 0)).toThrow(/must all be positive/);
    });

    it("refuses to dispatch a disposed program", () => {
        const { engine } = makeEngine();
        const shader = makeShader(engine);
        bindBoth(engine, shader);
        disposeComputeShader(shader);
        expect(() => dispatchCompute(engine, shader, 1)).toThrow(/has been disposed/);
    });

    it("refuses a program built for a different engine", () => {
        const { engine } = makeEngine();
        const other = makeEngine().engine;
        const shader = makeShader(engine);
        bindBoth(engine, shader);
        expect(() => dispatchCompute(other, shader, 1)).toThrow(/different engine/);
    });
});
