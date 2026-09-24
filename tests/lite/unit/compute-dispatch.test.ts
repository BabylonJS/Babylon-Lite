import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createComputeBindingSet } from "../../../packages/babylon-lite/src/compute/compute-bindings";
import { createComputeDispatch } from "../../../packages/babylon-lite/src/compute/compute-dispatch";
import { setComputeDispatchDynamicOffset } from "../../../packages/babylon-lite/src/compute/compute-dynamic-offset";
import { createComputeIndirectDispatch, setComputeIndirectDispatch } from "../../../packages/babylon-lite/src/compute/compute-indirect-dispatch";
import { createComputeImmediateShader, isComputeImmediatesSupported, setComputeDispatchImmediates } from "../../../packages/babylon-lite/src/compute/compute-immediates";
import { createComputePipelineVariant, createComputeVariantDispatch } from "../../../packages/babylon-lite/src/compute/compute-pipeline-variant";
import { addComputeDispatch, createComputeTask, submitComputeTasks } from "../../../packages/babylon-lite/src/compute/compute-task";
import { createComputeUniformArena, getComputeUniformSlotOffset, updateComputeUniformSlot } from "../../../packages/babylon-lite/src/compute/compute-uniform-arena";
import { createComputeShader, prepareComputeShader } from "../../../packages/babylon-lite/src/compute/compute-shader";
import { computeStorageBufferBinding } from "../../../packages/babylon-lite/src/compute/compute-storage-buffer-binding";
import { computeUniformBufferBinding } from "../../../packages/babylon-lite/src/compute/compute-uniform-buffer-binding";
import { createStorageBuffer, disposeStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";

const gpuGlobals = globalThis as unknown as Omit<typeof globalThis, "GPUBufferUsage" | "GPUShaderStage"> & {
    GPUBufferUsage?: Record<string, number>;
    GPUShaderStage?: Record<string, number>;
};
gpuGlobals.GPUBufferUsage ??= { COPY_SRC: 4, COPY_DST: 8, INDIRECT: 0x100, UNIFORM: 0x40, STORAGE: 0x80 };
gpuGlobals.GPUShaderStage ??= { COMPUTE: 4 };

function makeEngine() {
    const computePasses: {
        pipelines: GPUComputePipeline[];
        bindGroups: [number, GPUBindGroup, readonly number[] | undefined][];
        direct: [number, number, number][];
        indirect: [GPUBuffer, number][];
        immediates: GPUAllowSharedBufferSource[];
    }[] = [];
    const writes: [GPUBuffer, number, AllowSharedBufferSource, number | undefined, number | undefined][] = [];
    const bindGroups: GPUBindGroupDescriptor[] = [];
    const device = {
        limits: {
            maxBufferSize: 256 * 1024 * 1024,
            minUniformBufferOffsetAlignment: 256,
            minStorageBufferOffsetAlignment: 256,
            maxComputeWorkgroupsPerDimension: 65535,
            maxImmediateSize: 64,
        },
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const mapped = new ArrayBuffer(Number(descriptor.size));
            return {
                descriptor,
                getMappedRange: () => mapped,
                unmap: vi.fn(),
                destroy: vi.fn(),
            } as unknown as GPUBuffer;
        }),
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
        createComputePipeline: vi.fn((descriptor: GPUComputePipelineDescriptor) => descriptor as unknown as GPUComputePipeline),
        createComputePipelineAsync: vi.fn(async (descriptor: GPUComputePipelineDescriptor) => descriptor as unknown as GPUComputePipeline),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => {
            bindGroups.push(descriptor);
            return descriptor as unknown as GPUBindGroup;
        }),
        queue: {
            writeBuffer: vi.fn((buffer: GPUBuffer, offset: number, data: AllowSharedBufferSource, dataOffset?: number, size?: number) =>
                writes.push([buffer, offset, data, dataOffset, size])
            ),
        },
    } as unknown as GPUDevice;
    const engine = {
        _device: device,
        _currentEncoder: {
            beginComputePass: () => {
                const record = {
                    pipelines: [] as GPUComputePipeline[],
                    bindGroups: [] as [number, GPUBindGroup, readonly number[] | undefined][],
                    direct: [] as [number, number, number][],
                    indirect: [] as [GPUBuffer, number][],
                    immediates: [] as GPUAllowSharedBufferSource[],
                };
                computePasses.push(record);
                return {
                    setPipeline: (pipeline: GPUComputePipeline) => record.pipelines.push(pipeline),
                    setBindGroup: (group: number, bindings: GPUBindGroup, offsets?: Iterable<number>) =>
                        record.bindGroups.push([group, bindings, offsets ? [...offsets] : undefined]),
                    dispatchWorkgroups: (x: number, y: number, z: number) => record.direct.push([x, y, z]),
                    dispatchWorkgroupsIndirect: (buffer: GPUBuffer, offset: number) => record.indirect.push([buffer, offset]),
                    setImmediates: (_offset: number, data: GPUAllowSharedBufferSource) => record.immediates.push(data),
                    end: vi.fn(),
                } as unknown as GPUComputePassEncoder;
            },
        } as unknown as GPUCommandEncoder,
    } as unknown as EngineContext;
    return { engine, device, computePasses, writes, bindGroups };
}

const SOURCE = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@compute @workgroup_size(1) fn main() { output[0] = params.value; }`;

function createProgram(engine: EngineContext) {
    return createComputeShader(engine, {
        name: "fill",
        computeSource: SOURCE,
        bindings: [
            computeUniformBufferBinding("params", { group: 0, binding: 0, dynamicOffset: true, minBindingSize: 16 }),
            computeStorageBufferBinding("output", { group: 0, binding: 1, access: "read-write" }),
        ],
    });
}

describe("scheduled compute dispatch", () => {
    it("rejects direct task submission while a frame encoder is active", () => {
        const { engine } = makeEngine();
        const task = createComputeTask(engine, "direct");
        task.record();

        expect(() => submitComputeTasks([task])).toThrow(/while a frame is being recorded/);
    });

    it("replaces its recorded pass without retaining a disposed pass", () => {
        const { engine } = makeEngine();
        const task = createComputeTask(engine, "repeat-record");

        task.record();
        const firstPass = task._pass;
        task.record();

        expect(task._passes).toEqual([task._pass]);
        expect(task._pass).not.toBe(firstPass);
    });

    it("requires compute graphs to be recreated after the engine device changes", async () => {
        const { engine } = makeEngine();
        const shader = createComputeShader(engine, { computeSource: `@compute @workgroup_size(1) fn main() {}` });
        const bindings = createComputeBindingSet(shader, {});
        const indirect = createStorageBuffer(engine, 12, { writable: true, indirect: true });
        const indirectDispatch = createComputeIndirectDispatch(shader, bindings, { buffer: indirect });
        engine._device = makeEngine().device;

        await expect(prepareComputeShader(shader)).rejects.toThrow(/recreate the compute graph/);
        expect(() => setComputeIndirectDispatch(indirectDispatch, indirect)).toThrow(/recreate the compute graph/);
    });

    it("uses shader-derived layouts when automatic layout is requested", () => {
        const { engine, device } = makeEngine();
        const layout = {} as GPUBindGroupLayout;
        const pipeline = { getBindGroupLayout: vi.fn(() => layout) } as unknown as GPUComputePipeline;
        vi.mocked(device.createComputePipeline).mockReturnValueOnce(pipeline);
        const shader = createComputeShader(engine, {
            computeSource: SOURCE,
            automaticLayout: true,
            bindings: [computeUniformBufferBinding("params", { group: 0, binding: 0 }), computeStorageBufferBinding("output", { group: 0, binding: 1 })],
        });
        const params = createComputeUniformArena(createComputeTask(engine), 16, 1).buffer;
        const output = createStorageBuffer(engine, 16, { writable: true });

        createComputeBindingSet(shader, { params, output });

        expect(device.createComputePipeline).toHaveBeenCalledWith(expect.objectContaining({ layout: "auto" }));
        expect(pipeline.getBindGroupLayout).toHaveBeenCalledWith(0);
        expect(device.createBindGroupLayout).not.toHaveBeenCalled();
    });

    it("keeps inferred layouts paired with a synchronous pipeline created during preparation", async () => {
        const { engine, device, computePasses } = makeEngine();
        const layout = {} as GPUBindGroupLayout;
        const synchronousPipeline = { getBindGroupLayout: vi.fn(() => layout) } as unknown as GPUComputePipeline;
        const asynchronousPipeline = { getBindGroupLayout: vi.fn(() => ({})) } as unknown as GPUComputePipeline;
        let resolvePreparation!: (pipeline: GPUComputePipeline) => void;
        vi.mocked(device.createComputePipeline).mockReturnValueOnce(synchronousPipeline);
        vi.mocked(device.createComputePipelineAsync).mockReturnValueOnce(
            new Promise((resolve) => {
                resolvePreparation = resolve;
            })
        );
        const shader = createComputeShader(engine, {
            computeSource: SOURCE,
            automaticLayout: true,
            bindings: [computeUniformBufferBinding("params", { group: 0, binding: 0 }), computeStorageBufferBinding("output", { group: 0, binding: 1 })],
        });
        const preparation = prepareComputeShader(shader);
        const params = createComputeUniformArena(createComputeTask(engine), 16, 1).buffer;
        const output = createStorageBuffer(engine, 16, { writable: true });
        const bindings = createComputeBindingSet(shader, { params, output });

        resolvePreparation(asynchronousPipeline);
        await preparation;
        const task = createComputeTask(engine);
        addComputeDispatch(task, createComputeDispatch(shader, bindings, { size: { x: 1 } }));
        task.record();
        task._passes[0]!._execute();

        expect(computePasses[0]!.pipelines).toEqual([synchronousPipeline]);
        expect(synchronousPipeline.getBindGroupLayout).toHaveBeenCalledWith(0);
        expect(asynchronousPipeline.getBindGroupLayout).not.toHaveBeenCalled();
    });

    it("rejects dynamic offsets with automatic layouts", () => {
        const { engine } = makeEngine();

        expect(() =>
            createComputeShader(engine, {
                computeSource: SOURCE,
                automaticLayout: true,
                bindings: [computeStorageBufferBinding("output", { group: 0, binding: 1, dynamicOffset: true })],
            })
        ).toThrow(/automatic layouts do not support dynamic offset binding "output"/);
    });

    it("rejects pipeline variants for shaders with automatic layouts", () => {
        const { engine } = makeEngine();
        const shader = createComputeShader(engine, {
            computeSource: `override value: u32 = 1; @compute @workgroup_size(1) fn main() {}`,
            automaticLayout: true,
        });

        expect(() => createComputePipelineVariant(shader, { value: 2 })).toThrow(/require explicit binding layouts/);
    });

    it("accepts named and numeric WGSL override identifiers", () => {
        const { engine, computePasses } = makeEngine();
        const shader = createComputeShader(engine, {
            computeSource: `@id(0) override width: u32 = 1; override réflexion: u32 = 1; @compute @workgroup_size(1) fn Δέλτα() {}`,
            entryPoint: "Δέλτα",
        });
        const bindings = createComputeBindingSet(shader, {});
        const variant = createComputePipelineVariant(shader, { "0": 4, réflexion: 2 });
        const task = createComputeTask(engine);
        addComputeDispatch(task, createComputeVariantDispatch(variant, bindings, { size: { x: 1 } }));

        task.record();
        task._passes[0]!._execute();

        expect(computePasses[0]!.pipelines[0]).toMatchObject({ compute: { entryPoint: "Δέλτα", constants: { "0": 4, réflexion: 2 } } });
        expect(() => createComputePipelineVariant(shader, { "65535": 1 })).not.toThrow();
        expect(() => createComputePipelineVariant(shader, { "65536": 1 })).toThrow(/decimal @id/);
        expect(() => createComputePipelineVariant(shader, { "": 1 })).toThrow(/non-empty name/);
    });

    it("rejects invalid storage-buffer access modes", () => {
        expect(() => computeStorageBufferBinding("bad", { group: 0, binding: 0, access: "write" as "read" })).toThrow(/access must be/);
    });

    it("requires declared resources to be own properties", () => {
        const { engine } = makeEngine();
        const shader = createComputeShader(engine, {
            computeSource: SOURCE,
            bindings: [computeStorageBufferBinding("constructor", { group: 0, binding: 0 })],
        });

        expect(() => createComputeBindingSet(shader, {})).toThrow('binding "constructor" has no resource');
    });

    it("records a complete retained immediate image before direct dispatch", () => {
        vi.stubGlobal("navigator", { gpu: { wgslLanguageFeatures: new Set(["immediate_address_space"]) } });
        try {
            const { engine, computePasses, device } = makeEngine();
            expect(isComputeImmediatesSupported()).toBe(true);
            const shader = createComputeImmediateShader(engine, {
                computeSource: `requires immediate_address_space; var<immediate> params: vec4f; @compute @workgroup_size(1) fn main() {}`,
                immediateByteLength: 16,
            });
            const dispatch = createComputeDispatch(shader, createComputeBindingSet(shader, {}), { size: { x: 1 } });
            const data = new Float32Array([1, 2, 3, 4]);
            setComputeDispatchImmediates(dispatch, data);
            const task = createComputeTask(engine);
            addComputeDispatch(task, dispatch);

            task.record();
            task._passes[0]!._execute();

            expect(device.createPipelineLayout).toHaveBeenCalledWith(expect.objectContaining({ immediateSize: 16 }));
            expect(computePasses[0]!.immediates).toEqual([data]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("rejects unsupported or incomplete immediate data", () => {
        vi.stubGlobal("navigator", { gpu: {} });
        expect(isComputeImmediatesSupported()).toBe(false);
        vi.stubGlobal("navigator", { gpu: { wgslLanguageFeatures: new Set<string>() } });
        const { engine } = makeEngine();
        expect(() =>
            createComputeImmediateShader(engine, {
                computeSource: `@compute @workgroup_size(1) fn main() {}`,
                immediateByteLength: 16,
            })
        ).toThrow(/immediate_address_space/);
        vi.stubGlobal("navigator", { gpu: { wgslLanguageFeatures: new Set(["immediate_address_space"]) } });
        try {
            const shader = createComputeImmediateShader(engine, {
                computeSource: `requires immediate_address_space; var<immediate> params: vec4f; @compute @workgroup_size(1) fn main() {}`,
                immediateByteLength: 16,
            });
            const dispatch = createComputeDispatch(shader, createComputeBindingSet(shader, {}), { size: { x: 1 } });
            expect(() => setComputeDispatchImmediates(dispatch, new Uint32Array(3))).toThrow(/exactly 16 bytes/);
            const task = createComputeTask(engine);
            addComputeDispatch(task, dispatch);
            task.record();
            expect(() => task._passes[0]!._execute()).toThrow(/initialize all 16 bytes/);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("records differently parameterized dispatches into one pass with one uniform upload", () => {
        const { engine, computePasses, writes } = makeEngine();
        const task = createComputeTask(engine, "batch");
        const arena = createComputeUniformArena(task, 16, 2);
        updateComputeUniformSlot(arena, 0, new Float32Array([1, 0, 0, 0]));
        updateComputeUniformSlot(arena, 1, new Float32Array([2, 0, 0, 0]));

        const shader = createProgram(engine);
        const output = createStorageBuffer(engine, 16, { writable: true });
        const bindings = createComputeBindingSet(shader, { params: { buffer: arena.buffer, size: 16 }, output });
        const first = createComputeDispatch(shader, bindings, { size: { x: 4 } });
        setComputeDispatchDynamicOffset(first, "params", getComputeUniformSlotOffset(arena, 0));
        addComputeDispatch(task, first);
        const second = createComputeDispatch(shader, bindings, { size: { x: 8 } });
        setComputeDispatchDynamicOffset(second, "params", getComputeUniformSlotOffset(arena, 1));
        addComputeDispatch(task, second);

        task.record();
        task._passes[0]!._execute();

        expect(computePasses).toHaveLength(1);
        expect(computePasses[0]!.pipelines).toHaveLength(1);
        expect(computePasses[0]!.bindGroups.map((entry) => entry[2])).toEqual([[0], [256]]);
        expect(computePasses[0]!.direct).toEqual([
            [4, 1, 1],
            [8, 1, 1],
        ]);
        expect(writes).toHaveLength(1);
    });

    it("reuses immutable A/B/A binding sets without rebuilding them", () => {
        const { engine, computePasses, bindGroups } = makeEngine();
        const shader = createComputeShader(engine, {
            computeSource: `@group(0) @binding(0) var<storage, read> input: array<f32>; @compute @workgroup_size(1) fn main() {}`,
            bindings: [computeStorageBufferBinding("input", { group: 0, binding: 0 })],
        });
        const a = createComputeBindingSet(shader, { input: createStorageBuffer(engine, new Float32Array([1])) });
        const b = createComputeBindingSet(shader, { input: createStorageBuffer(engine, new Float32Array([2])) });
        const task = createComputeTask(engine);
        addComputeDispatch(task, createComputeDispatch(shader, a, { size: { x: 1 } }));
        addComputeDispatch(task, createComputeDispatch(shader, b, { size: { x: 1 } }));
        addComputeDispatch(task, createComputeDispatch(shader, a, { size: { x: 1 } }));

        task.record();
        task._passes[0]!._execute();

        expect(bindGroups).toHaveLength(2);
        expect(computePasses[0]!.bindGroups.map((entry) => entry[1])).toEqual([a._groups![0], b._groups![0], a._groups![0]]);
    });

    it("supplies explicit zero offsets for untouched dynamic bindings", () => {
        const { engine, computePasses } = makeEngine();
        const task = createComputeTask(engine);
        const arena = createComputeUniformArena(task, 16, 1);
        const shader = createProgram(engine);
        const bindings = createComputeBindingSet(shader, {
            params: { buffer: arena.buffer, size: 16 },
            output: createStorageBuffer(engine, 16, { writable: true }),
        });
        addComputeDispatch(task, createComputeDispatch(shader, bindings, { size: { x: 1 } }));

        task.record();
        task._passes[0]!._execute();

        expect(computePasses[0]!.bindGroups[0]![2]).toEqual([0]);
    });

    it("rejects a cached binding set after a bound resource is disposed", () => {
        const { engine } = makeEngine();
        const shader = createComputeShader(engine, {
            computeSource: `@group(0) @binding(0) var<storage, read> input: array<f32>; @compute @workgroup_size(1) fn main() {}`,
            bindings: [computeStorageBufferBinding("input", { group: 0, binding: 0 })],
        });
        const input = createStorageBuffer(engine, new Float32Array([1]));
        const bindings = createComputeBindingSet(shader, { input });
        const task = createComputeTask(engine);
        addComputeDispatch(task, createComputeDispatch(shader, bindings, { size: { x: 1 } }));
        task.record();
        disposeStorageBuffer(input);

        expect(() => task._passes[0]!._execute()).toThrow(/disposed or invalid/);
    });

    it("accepts a zero-sized no-op and supports indirect dispatch", () => {
        const { engine, computePasses } = makeEngine();
        const shader = createComputeShader(engine, { computeSource: `@compute @workgroup_size(1) fn main() {}` });
        const bindings = createComputeBindingSet(shader, {});
        const task = createComputeTask(engine);
        addComputeDispatch(task, createComputeDispatch(shader, bindings, { size: { x: 0 } }));
        const indirect = createStorageBuffer(engine, new Uint32Array([1, 2, 3]), { writable: true, indirect: true });
        const indirectDispatch = createComputeIndirectDispatch(shader, bindings, { buffer: indirect });
        const recorder = indirectDispatch._record;
        setComputeIndirectDispatch(indirectDispatch, indirect);
        expect(indirectDispatch._record).toBe(recorder);
        addComputeDispatch(task, indirectDispatch);

        task.record();
        task._passes[0]!._execute();

        expect(computePasses[0]!.direct).toEqual([[0, 1, 1]]);
        expect(computePasses[0]!.indirect).toEqual([[indirect._buffer, 0]]);
    });

    it("rejects declarations and ranges beyond device limits", () => {
        const { engine } = makeEngine();
        Object.assign(engine._device.limits, {
            maxBindGroups: 1,
            maxBindingsPerBindGroup: 2,
            maxStorageBufferBindingSize: 16,
        });
        expect(() =>
            createComputeShader(engine, {
                computeSource: `@compute @workgroup_size(1) fn main() {}`,
                bindings: [computeStorageBufferBinding("input", { group: 1, binding: 0 })],
            })
        ).toThrow(/maxBindGroups/);
        expect(() =>
            createComputeShader(engine, {
                computeSource: `@compute @workgroup_size(1) fn main() {}`,
                bindings: [computeStorageBufferBinding("input", { group: 0, binding: 2 })],
            })
        ).toThrow(/maxBindingsPerBindGroup/);

        const shaderWithRange = createComputeShader(engine, {
            computeSource: `@group(0) @binding(0) var<storage, read> input: array<f32>; @compute @workgroup_size(1) fn main() {}`,
            bindings: [computeStorageBufferBinding("input", { group: 0, binding: 0 })],
        });
        const input = createStorageBuffer(engine, new Float32Array(8));
        expect(() => createComputeBindingSet(shaderWithRange, { input })).toThrow(/maximum binding size/);
        expect(() => createComputeBindingSet(shaderWithRange, { input: { buffer: input, size: 16 } })).not.toThrow();
        Object.assign(engine._device.limits, { minStorageBufferOffsetAlignment: 4, maxStorageBufferBindingSize: 64 });
        expect(() => createComputeBindingSet(shaderWithRange, { input: { buffer: input, offset: input.byteLength } })).toThrow(/at least 4 bytes/);
    });

    it("allows a large uniform arena while enforcing the limit on each binding range", () => {
        const { engine } = makeEngine();
        Object.assign(engine._device.limits, { maxBufferSize: 512, maxUniformBufferBindingSize: 16 });
        const task = createComputeTask(engine);
        const arena = createComputeUniformArena(task, 16, 2);
        const shader = createComputeShader(engine, {
            computeSource: "@group(0) @binding(0) var<uniform> params: vec4f; @compute @workgroup_size(1) fn main() {}",
            bindings: [computeUniformBufferBinding("params", { group: 0, binding: 0 })],
        });
        expect(arena.buffer.byteLength).toBe(512);
        expect(() => createComputeBindingSet(shader, { params: arena.buffer })).toThrow(/maximum binding size/);
        expect(() => createComputeBindingSet(shader, { params: { buffer: arena.buffer, offset: 256, size: 16 } })).not.toThrow();
    });

    it("rejects uniform, storage, and dynamic buffer counts beyond device limits", () => {
        const { engine } = makeEngine();
        Object.assign(engine._device.limits, {
            maxUniformBuffersPerShaderStage: 1,
            maxStorageBuffersPerShaderStage: 1,
            maxDynamicUniformBuffersPerPipelineLayout: 1,
            maxDynamicStorageBuffersPerPipelineLayout: 1,
        });

        expect(() =>
            createComputeShader(engine, {
                computeSource: `@compute @workgroup_size(1) fn main() {}`,
                bindings: [computeUniformBufferBinding("a", { group: 0, binding: 0 }), computeUniformBufferBinding("b", { group: 0, binding: 1 })],
            })
        ).toThrow(/uniform buffers/);
        expect(() =>
            createComputeShader(engine, {
                computeSource: `@compute @workgroup_size(1) fn main() {}`,
                bindings: [computeStorageBufferBinding("a", { group: 0, binding: 0 }), computeStorageBufferBinding("b", { group: 0, binding: 1 })],
            })
        ).toThrow(/storage buffers/);
        Object.assign(engine._device.limits, {
            maxUniformBuffersPerShaderStage: 2,
            maxStorageBuffersPerShaderStage: 2,
        });
        expect(() =>
            createComputeShader(engine, {
                computeSource: `@compute @workgroup_size(1) fn main() {}`,
                bindings: [
                    computeUniformBufferBinding("a", { group: 0, binding: 0, dynamicOffset: true, minBindingSize: 16 }),
                    computeUniformBufferBinding("b", { group: 0, binding: 1, dynamicOffset: true, minBindingSize: 16 }),
                ],
            })
        ).toThrow(/dynamic uniform buffers/);
        expect(() =>
            createComputeShader(engine, {
                computeSource: `@compute @workgroup_size(1) fn main() {}`,
                bindings: [
                    computeStorageBufferBinding("a", { group: 0, binding: 0, dynamicOffset: true, minBindingSize: 16 }),
                    computeStorageBufferBinding("b", { group: 0, binding: 1, dynamicOffset: true, minBindingSize: 16 }),
                ],
            })
        ).toThrow(/dynamic storage buffers/);
    });
});
