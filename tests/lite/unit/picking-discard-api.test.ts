import { describe, expect, it } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { createGpuPicker, pickAsync } from "../../../packages/babylon-lite/src/picking/gpu-picker";
import { getPickingPipelineSet } from "../../../packages/babylon-lite/src/picking/picking-pipeline";
import { pickingShaderSource, pickingThinInstanceShaderSource } from "../../../packages/babylon-lite/src/picking/picking-shader";
import type { PickDiscardRule, PickOptions } from "../../../packages/babylon-lite/src";

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function makeEngine(): {
    engine: EngineContext;
    device: {
        bindGroupLayouts: GPUBindGroupLayoutDescriptor[];
        shaderModules: GPUShaderModuleDescriptor[];
        pipelineLayouts: GPUPipelineLayoutDescriptor[];
        renderPipelines: GPURenderPipelineDescriptor[];
    };
} {
    const device = {
        bindGroupLayouts: [] as GPUBindGroupLayoutDescriptor[],
        shaderModules: [] as GPUShaderModuleDescriptor[],
        pipelineLayouts: [] as GPUPipelineLayoutDescriptor[],
        renderPipelines: [] as GPURenderPipelineDescriptor[],
        createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout {
            this.bindGroupLayouts.push(descriptor);
            return descriptor as unknown as GPUBindGroupLayout;
        },
        createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule {
            this.shaderModules.push(descriptor);
            return descriptor as unknown as GPUShaderModule;
        },
        createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout {
            this.pipelineLayouts.push(descriptor);
            return { descriptor, bindGroupLayouts: descriptor.bindGroupLayouts } as unknown as GPUPipelineLayout;
        },
        createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline {
            this.renderPipelines.push(descriptor);
            const layout = descriptor.layout as unknown as { bindGroupLayouts?: readonly GPUBindGroupLayout[] };
            return {
                descriptor,
                getBindGroupLayout(index: number): GPUBindGroupLayout {
                    return layout.bindGroupLayouts?.[index] ?? ({ label: `layout-${index}` } as unknown as GPUBindGroupLayout);
                },
                _bindGroupLayoutCount: layout.bindGroupLayouts?.length ?? 0,
            } as unknown as GPURenderPipeline;
        },
    };

    return {
        engine: { _device: device as unknown as GPUDevice } as unknown as EngineContext,
        device,
    };
}

function makePickerEngine(): ReturnType<typeof makeEngine> & { pass: { drawCalls: { group2Bound: boolean }[] } } {
    const base = makeEngine();
    const passState = {
        drawCalls: [] as { group2Bound: boolean }[],
        pipeline: null as (GPURenderPipeline & { _bindGroupLayoutCount?: number }) | null,
        bindGroups: new Set<number>(),
        setPipeline(pipeline: GPURenderPipeline) {
            this.pipeline = pipeline;
            this.bindGroups.clear();
        },
        setBindGroup(index: number) {
            this.bindGroups.add(index);
        },
        setVertexBuffer() {},
        setIndexBuffer() {},
        drawIndexed() {
            if ((this.pipeline?._bindGroupLayoutCount ?? 0) > 2 && !this.bindGroups.has(2)) {
                throw new Error("No bind group set at group index 2.");
            }
            this.drawCalls.push({ group2Bound: this.bindGroups.has(2) });
        },
        end() {},
    };

    const device = base.engine._device as unknown as {
        createTexture: (descriptor: GPUTextureDescriptor) => GPUTexture;
        createBuffer: (descriptor: GPUBufferDescriptor) => GPUBuffer;
        createBindGroup: (descriptor: GPUBindGroupDescriptor) => GPUBindGroup;
        createCommandEncoder: (descriptor?: GPUCommandEncoderDescriptor) => GPUCommandEncoder;
        queue: { writeBuffer: GPUQueue["writeBuffer"]; submit: GPUQueue["submit"] };
    };
    device.queue = {
        writeBuffer() {},
        submit() {},
    };
    device.createTexture = () =>
        ({
            createView: () => ({}),
            destroy() {},
        }) as unknown as GPUTexture;
    device.createBuffer = (descriptor) => {
        const data = new ArrayBuffer(Math.max(256, descriptor.size));
        if (descriptor.label === "pick-color-staging") {
            new Uint8Array(data)[2] = 1;
        } else if (descriptor.label === "pick-depth-staging") {
            new Float32Array(data)[0] = 0.5;
        }
        // Mirrors real WebGPU: a GPUBuffer allows only ONE outstanding map at a time — calling mapAsync
        // again before the previous map's unmap() throws. A tiny setTimeout (rather than resolving on the
        // same microtask) gives two pickAsync calls fired back-to-back a real chance to interleave, the
        // same way two rAF-driven GPU picks racing in a browser would.
        let mapped = false;
        return {
            destroy() {},
            getMappedRange: () => data,
            mapAsync: () =>
                new Promise<void>((res, rej) => {
                    if (mapped) {
                        rej(new Error(`Failed to execute 'mapAsync' on 'GPUBuffer': Buffer already has an outstanding map pending.`));
                        return;
                    }
                    mapped = true;
                    setTimeout(res, 0);
                }),
            unmap() {
                mapped = false;
            },
        } as unknown as GPUBuffer;
    };
    device.createBindGroup = (descriptor) => descriptor as unknown as GPUBindGroup;
    device.createCommandEncoder = () =>
        ({
            beginRenderPass: () => passState,
            copyTextureToBuffer() {},
            finish: () => ({}),
        }) as unknown as GPUCommandEncoder;

    (globalThis as unknown as { GPUMapMode: { READ: number } }).GPUMapMode ??= { READ: 1 };
    return { ...base, pass: passState };
}

function makePickScene(engine: EngineContext): { scene: Parameters<typeof createGpuPicker>[0]; mesh: Mesh; discardBuffer: GPUBuffer } {
    const discardBuffer = {} as GPUBuffer;
    const mesh = {
        name: "pickable",
        material: {},
        receiveShadows: false,
        children: [],
        worldMatrix: IDENTITY,
        worldMatrixVersion: 1,
        _gpu: {
            positionBuffer: {},
            normalBuffer: {},
            uvBuffer: {},
            indexBuffer: {},
            indexCount: 3,
            indexFormat: "uint32",
        },
    } as unknown as Mesh;
    return {
        mesh,
        discardBuffer,
        scene: {
            surface: {
                engine,
                canvas: { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
            },
            camera: {
                fov: Math.PI / 3,
                nearPlane: 0.1,
                farPlane: 100,
                children: [],
                worldMatrix: IDENTITY,
                worldMatrixVersion: 1,
                _viewCache: new Float32Array(16),
                _projCache: new Float32Array(16),
                _vpCache: new Float32Array(16),
            },
            meshes: [mesh],
            _gsMeshes: [],
        } as unknown as Parameters<typeof createGpuPicker>[0],
    };
}

describe("picking discard shader API", () => {
    it("keeps the default picker shader non-discarding", () => {
        const regular = pickingShaderSource();
        const thin = pickingThinInstanceShaderSource();

        expect(regular).toContain("struct PickDiscardInput");
        expect(regular).toContain("fn shouldDiscardPick(input: PickDiscardInput) -> bool");
        expect(regular).toContain("return false;");
        expect(regular).toContain("out.hasThinInstance = 0u;");
        expect(regular).toContain("out.thinInstanceIndex = 0xffffffffu;");

        expect(thin).toContain("fn shouldDiscardPick(input: PickDiscardInput) -> bool");
        expect(thin).toContain("return false;");
        expect(thin).toContain("out.hasThinInstance = 1u;");
        expect(thin).toContain("out.thinInstanceIndex = instanceIndex;");
        expect(thin).toContain("out.instanceExtras = vec4f(m[0].w, m[1].w, m[2].w, m[3].w);");
    });

    it("injects a custom discard rule into regular and thin-instance picking shaders", () => {
        const discardWgsl = `
fn shouldDiscardPick(input: PickDiscardInput) -> bool {
return input.hasThinInstance == 1u && input.instanceExtras.x > 4.0;
}`;

        const regular = pickingShaderSource({ discardWgsl });
        const thin = pickingThinInstanceShaderSource({ discardWgsl });

        expect(regular).toContain(discardWgsl);
        expect(thin).toContain(discardWgsl);
        expect(regular).toContain("let discardInput = PickDiscardInput(input.worldPos, input.pickId, input.thinInstanceIndex, input.hasThinInstance, input.instanceExtras);");
        expect(thin).toContain("let world = mat4x4f(");
        expect(thin).toContain("vec4f(m[0].xyz, 0.0)");
        expect(thin).toContain("vec4f(m[3].xyz, 1.0)");
    });
});

describe("picking discard pipeline API", () => {
    it("allows public discard rules to supply typed-array storage data", () => {
        const discard: PickDiscardRule = {
            key: "public-bindings",
            wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return input.pickId == 1u; }",
            storage: [{ name: "clipData", type: "array<vec4<f32>>", data: () => new Float32Array(4) }],
        };
        const options: PickOptions = { discard };

        expect(options.discard).toBe(discard);
    });

    it("caches the default regular/thin pipeline set per device", () => {
        const { engine, device } = makeEngine();

        const first = getPickingPipelineSet(engine);
        const second = getPickingPipelineSet(engine);

        expect(second).toBe(first);
        expect(first.discardBGL).toBeNull();
        expect(device.renderPipelines).toHaveLength(2);
        expect(device.shaderModules.map((m) => m.label)).toEqual(["picking-shader", "picking-ti-shader"]);
        expect(device.pipelineLayouts.every((layout) => Array.from(layout.bindGroupLayouts).length === 2)).toBe(true);
    });

    it("creates a discard pipeline set with a group-2 layout and injected WGSL", () => {
        const { engine, device } = makeEngine();
        const discard = {
            key: "clip-volume",
            wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return clipData[0].x > 0.0 && input.pickId == 7u; }",
            storage: [{ name: "clipData", type: "array<vec4<f32>>" }],
        };

        const set = getPickingPipelineSet(engine, discard);

        expect(set.discardBGL).not.toBeNull();
        expect(device.bindGroupLayouts.find((layout) => layout.label === "picking-discard-clip-volume-bgl")).toMatchObject({
            label: "picking-discard-clip-volume-bgl",
            entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } }],
        });
        expect(device.renderPipelines).toHaveLength(2);
        expect(device.shaderModules.every((module) => String(module.code).includes(discard.wgsl))).toBe(true);
        expect(device.shaderModules.every((module) => String(module.code).includes("@group(2) @binding(0) var<storage, read> clipData: array<vec4<f32>>;"))).toBe(true);
        expect(device.pipelineLayouts.every((layout) => Array.from(layout.bindGroupLayouts).length === 3)).toBe(true);
    });

    it("binds discard group-2 resources before drawing a discard pipeline", async () => {
        const { engine, pass } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        const picker = createGpuPicker(scene);
        const discard: PickDiscardRule = {
            key: "storage-discard",
            wgsl: `
fn shouldDiscardPick(input: PickDiscardInput) -> bool { return data[0].x > 1.0 && input.pickId == 0u; }`,
            storage: [{ name: "data", type: "array<vec4f>", data: (m) => (m === mesh ? new Float32Array([2, 0, 0, 0]) : null) }],
        };

        const info = await pickAsync(picker, 4, 4, { discard });

        expect(info.hit).toBe(true);
        expect(pass.drawCalls).toEqual([{ group2Bound: true }]);
    });

    // Regression: a picker's 1×1 readback buffers (colorStaging/depthStaging) are lazily created ONCE and
    // reused for every pick. Two overlapping pickAsync calls on the SAME picker used to race mapAsync on
    // those shared buffers — e.g. a cursor-following hover preview picking on every pointermove, racing a
    // pick fired by a click landing before the hover pick unmapped — throwing "Buffer already has an
    // outstanding map pending." The mock buffer above reproduces that exact throw for a real concurrent
    // mapAsync call, so this test fails against the old, unserialized pickAsync.
    it("serializes overlapping pickAsync calls on the same picker instead of racing their shared staging buffers", async () => {
        const { engine } = makePickerEngine();
        const { scene } = makePickScene(engine);
        const picker = createGpuPicker(scene);

        // Fire both WITHOUT awaiting the first — this is the overlap that used to throw.
        const [a, b] = await Promise.all([pickAsync(picker, 4, 4), pickAsync(picker, 4, 4)]);

        expect(a.hit).toBe(true);
        expect(b.hit).toBe(true);
    });

    it("invalidates cached pipeline sets when the WebGPU device changes", () => {
        const first = makeEngine();
        const second = makeEngine();

        getPickingPipelineSet(first.engine);
        getPickingPipelineSet(second.engine);

        expect(first.device.renderPipelines).toHaveLength(2);
        expect(second.device.renderPipelines).toHaveLength(2);
    });
});
