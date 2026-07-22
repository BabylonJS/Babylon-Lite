import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { createGpuPicker, pickAsync } from "../../../packages/babylon-lite/src/picking/gpu-picker";
import { getPickingPipelineSet } from "../../../packages/babylon-lite/src/picking/picking-pipeline";
import { pickingShaderSource, pickingThinInstanceShaderSource } from "../../../packages/babylon-lite/src/picking/picking-shader";
import { getPickingRegularPipeline, getPickingVertexDataPipelineSet, pickingVertexDataShaderSource } from "../../../packages/babylon-lite/src/picking/picking-vertex-data";
import type { PickDiscardRule, PickOptions } from "../../../packages/babylon-lite/src";
import type { PickPipelineModule, PickSource } from "../../../packages/babylon-lite/src/picking/pick-contributor";

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

interface MockBufferRecord {
    descriptor: GPUBufferDescriptor;
    destroy: ReturnType<typeof vi.fn>;
}

function makePickerEngine(): ReturnType<typeof makeEngine> & {
    pass: { drawCalls: { group2Bound: boolean }[]; boundVertexSlots: number[] };
    buffers: MockBufferRecord[];
    writes: { label: string | undefined; data: Float32Array }[];
} {
    const base = makeEngine();
    const buffers: MockBufferRecord[] = [];
    const labels = new WeakMap<object, string | undefined>();
    const writes: { label: string | undefined; data: Float32Array }[] = [];
    const passState = {
        drawCalls: [] as { group2Bound: boolean }[],
        pipeline: null as (GPURenderPipeline & { _bindGroupLayoutCount?: number }) | null,
        bindGroups: new Set<number>(),
        boundVertexSlots: [] as number[],
        setPipeline(pipeline: GPURenderPipeline) {
            this.pipeline = pipeline;
            this.bindGroups.clear();
        },
        setBindGroup(index: number) {
            this.bindGroups.add(index);
        },
        setVertexBuffer(slot: number) {
            this.boundVertexSlots.push(slot);
        },
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
        writeBuffer(buffer, _offset, data, dataOffset, size) {
            const source = ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset + (dataOffset ?? 0), size ?? data.byteLength - (dataOffset ?? 0))
                : new Uint8Array(data, dataOffset ?? 0, size);
            const copy = source.slice().buffer;
            writes.push({ label: labels.get(buffer as object), data: new Float32Array(copy) });
        },
        submit() {},
    };
    device.createTexture = () =>
        ({
            createView: () => ({}),
            destroy() {},
        }) as unknown as GPUTexture;
    device.createBuffer = (descriptor) => {
        const data = new ArrayBuffer(Math.max(256, descriptor.size));
        const destroy = vi.fn();
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
        const buffer = {
            destroy,
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
        labels.set(buffer as object, descriptor.label);
        buffers.push({ descriptor: { ...descriptor }, destroy });
        return buffer;
    };
    device.createBindGroup = (descriptor) => descriptor as unknown as GPUBindGroup;
    device.createCommandEncoder = () =>
        ({
            beginRenderPass: () => passState,
            copyTextureToBuffer() {},
            finish: () => ({}),
        }) as unknown as GPUCommandEncoder;

    (globalThis as unknown as { GPUMapMode: { READ: number } }).GPUMapMode ??= { READ: 1 };
    base.engine._retirements = [];
    return { ...base, pass: passState, buffers, writes };
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
            _pickSources: [],
        } as unknown as Parameters<typeof createGpuPicker>[0],
    };
}

describe("picking shader API", () => {
    it("keeps the default picker shader non-discarding", () => {
        const regular = pickingShaderSource();
        const thin = pickingThinInstanceShaderSource();

        expect(regular).toContain("struct PickDiscardInput");
        expect(regular).toContain("fragmentCoord: vec2f");
        expect(regular).toContain("fn shouldDiscardPick(input: PickDiscardInput) -> bool");
        expect(regular).toContain("return false;");
        expect(regular).toContain("fn adjustPickWorld(worldPos: vec3f, instanceExtras: vec4f, thinInstanceIndex: u32) -> vec3f");
        expect(regular).toContain("let wp = adjustPickWorld((mesh.world * vec4f(position, 1.0)).xyz, vec4f(0.0), 0xffffffffu);");
        expect(regular).toContain("out.hasThinInstance = 0u;");
        expect(regular).toContain("out.thinInstanceIndex = 0xffffffffu;");
        expect(regular).not.toContain("vertexData");
        expect(regular).toContain("PickDiscardInput(input.worldPos, scene.fragmentCoord");

        expect(thin).toContain("fn shouldDiscardPick(input: PickDiscardInput) -> bool");
        expect(thin).toContain("return false;");
        expect(thin).toContain("let extras = vec4f(m[0].w, m[1].w, m[2].w, m[3].w);");
        expect(thin).toContain("let wp = adjustPickWorld((world * vec4f(position, 1.0)).xyz, extras, instanceIndex);");
        expect(thin).toContain("out.hasThinInstance = 1u;");
        expect(thin).toContain("out.thinInstanceIndex = instanceIndex;");
        expect(thin).toContain("out.instanceExtras = extras;");
        expect(thin).not.toContain("vertexData");
        expect(thin).toContain("PickDiscardInput(input.worldPos, scene.fragmentCoord");
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
        const discardCall =
            "if (shouldDiscardPick(PickDiscardInput(input.worldPos, scene.fragmentCoord, input.pickId, input.thinInstanceIndex, input.hasThinInstance, input.instanceExtras))) { discard; }";
        expect(regular).toContain(discardCall);
        expect(thin).toContain(discardCall);
        expect(thin).toContain("let world = mat4x4f(");
        expect(thin).toContain("vec4f(m[0].xyz, 0.0)");
        expect(thin).toContain("vec4f(m[3].xyz, 1.0)");
    });

    it("forwards optional regular-mesh vertex data as one flat padded vec4", () => {
        const zero = pickingVertexDataShaderSource(false, { vertexDataComponents: 0 });
        const uv = pickingVertexDataShaderSource(false, { vertexDataComponents: 2 });
        const normal = pickingVertexDataShaderSource(false, { vertexDataComponents: 3 });
        const tangent = pickingVertexDataShaderSource(false, { vertexDataComponents: 4 });
        const thin = pickingVertexDataShaderSource(true, { vertexDataComponents: 0 });

        expect(zero).toContain("out.vertexData = vec4f(0.0);");
        expect(uv).toContain("@location(5) vertexData: vec2f");
        expect(uv).toContain("out.vertexData = vec4f(vertexData, 0.0, 0.0);");
        expect(normal).toContain("@location(5) vertexData: vec3f");
        expect(normal).toContain("out.vertexData = vec4f(vertexData, 0.0);");
        expect(tangent).toContain("@location(5) vertexData: vec4f");
        expect(tangent).toContain("out.vertexData = vertexData;");
        for (const source of [uv, normal, tangent]) {
            expect(source).toContain("@location(5) @interpolate(flat) vertexData: vec4f");
        }
        expect(thin).toContain("out.vertexData = vec4f(0.0);");
    });

    it("injects a custom world adjustment into regular and thin-instance picking shaders", () => {
        const worldAdjustWgsl = `
fn adjustPickWorld(worldPos: vec3f, instanceExtras: vec4f, thinInstanceIndex: u32) -> vec3f {
if (thinInstanceIndex == 0xffffffffu) { return worldPos; }
return worldPos + offsets[thinInstanceIndex].xyz + instanceExtras.xyz;
}`;
        const options = {
            worldAdjustWgsl,
            storage: [{ name: "offsets", type: "array<vec4f>" }],
        };

        const regular = pickingShaderSource(options);
        const thin = pickingThinInstanceShaderSource(options);

        for (const source of [regular, thin]) {
            expect(source).toContain(worldAdjustWgsl);
            expect(source.match(/fn adjustPickWorld/g)).toHaveLength(1);
            expect(source).toContain("@group(2) @binding(0) var<storage, read> offsets: array<vec4f>;");
        }
        expect(regular).toContain("adjustPickWorld((mesh.world * vec4f(position, 1.0)).xyz, vec4f(0.0), 0xffffffffu)");
        expect(thin).toContain("adjustPickWorld((world * vec4f(position, 1.0)).xyz, extras, instanceIndex)");
    });
});

describe("picking discard pipeline API", () => {
    it("allows public discard rules to supply typed-array storage data", () => {
        const discard: PickDiscardRule = {
            key: "public-bindings",
            wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return input.pickId == 1u; }",
            storage: [{ name: "clipData", type: "array<vec4<f32>>", data: () => new Float32Array(4) }],
            vertexData: "color",
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

    it("creates the requested regular vertex-data pipeline without changing thin-instance layout", () => {
        const { engine, device } = makeEngine();
        const discard = {
            key: "host-id-tangent",
            wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return input.vertexData.x > 0.0; }",
            vertexData: "tangent" as const,
        };

        const set = getPickingVertexDataPipelineSet(engine, discard);
        getPickingRegularPipeline(engine, set, discard, undefined, { attribute: "tangent" });

        expect(device.renderPipelines).toHaveLength(3);
        const dataPipelineDescriptor = device.renderPipelines.find((pipeline) => pipeline.label === "picking-host-id-tangent-vb-12-0-tangent-16-0-pipeline")!;
        expect(dataPipelineDescriptor.vertex.buffers).toEqual([
            { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
            { arrayStride: 16, attributes: [{ shaderLocation: 5, offset: 0, format: "float32x4" }] },
        ]);
        const thinPipeline = device.renderPipelines.find((pipeline) => pipeline.label === "picking-ti-host-id-tangent-pipeline")!;
        expect(thinPipeline.vertex.buffers).toHaveLength(1);
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

    it("binds requested regular vertex data only when that mesh owns the buffer", async () => {
        const { engine, pass } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        (mesh._gpu as { tangentBuffer?: GPUBuffer }).tangentBuffer = {} as GPUBuffer;
        const discard: PickDiscardRule = {
            key: "vertex-data-discard",
            wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return input.vertexData.x > 0.0; }",
            vertexData: "tangent",
        };

        await pickAsync(createGpuPicker(scene), 4, 4, { discard });

        expect(pass.boundVertexSlots).toEqual([0, 1]);
    });

    it("does not bind the zero-filled UV placeholder when the mesh has no UV attribute", async () => {
        const { engine, pass } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        (mesh._gpu as { hasUv?: boolean }).hasUv = false;
        const discard: PickDiscardRule = {
            key: "missing-uv-data",
            wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return input.vertexData.x > 0.0; }",
            vertexData: "uv",
        };

        await pickAsync(createGpuPicker(scene), 4, 4, { discard });

        expect(pass.boundVertexSlots).toEqual([0]);
    });

    it("uses interleaved position and vertex-data stride and offsets", async () => {
        const { engine, device } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        const shared = {} as GPUBuffer;
        mesh._gpu = {
            ...mesh._gpu,
            positionBuffer: shared,
            uvBuffer: shared,
            hasUv: true,
            _vbLayout: {
                _p: { _stride: 32, _offset: 0 },
                _u: { _stride: 32, _offset: 24 },
            },
        };
        const discard: PickDiscardRule = {
            key: "interleaved-uv-data",
            wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return input.vertexData.x > 0.0; }",
            vertexData: "uv",
        };

        await pickAsync(createGpuPicker(scene), 4, 4, { discard });

        const dataPipeline = device.renderPipelines.find(
            (pipeline) => String(pipeline.label).includes("interleaved-uv-data-vb") && Array.from(pipeline.vertex.buffers ?? []).length === 2
        );
        expect(dataPipeline?.vertex.buffers).toEqual([
            { arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
            { arrayStride: 32, attributes: [{ shaderLocation: 5, offset: 24, format: "float32x2" }] },
        ]);
    });

    it("uses an interleaved position layout for a default pick", async () => {
        const { engine, device } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        mesh._gpu = {
            ...mesh._gpu,
            _vbLayout: {
                _p: { _stride: 24, _offset: 8 },
            },
        };

        await pickAsync(createGpuPicker(scene), 4, 4);

        const interleavedPipeline = device.renderPipelines.find(
            (pipeline) => String(pipeline.label).includes("picking-vb") && Array.from(pipeline.vertex.buffers ?? []).length === 1
        );
        expect(interleavedPipeline?.vertex.buffers).toEqual([{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 8, format: "float32x3" }] }]);
    });

    it("uses an interleaved position layout for a thin-instance pick", async () => {
        const { engine, device } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        mesh._gpu = {
            ...mesh._gpu,
            _vbLayout: {
                _p: { _stride: 24, _offset: 8 },
            },
        };
        mesh.thinInstances = {
            count: 1,
            _gpuBuffer: {} as GPUBuffer,
        } as NonNullable<Mesh["thinInstances"]>;

        await pickAsync(createGpuPicker(scene), 4, 4);

        const interleavedPipeline = device.renderPipelines.find((pipeline) => String(pipeline.label).includes("picking-ti-vb"));
        expect(interleavedPipeline?.vertex.buffers).toEqual([{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 8, format: "float32x3" }] }]);
    });

    it("preserves the legacy discard input for interleaved picks without vertex data", async () => {
        const discard: PickDiscardRule = {
            key: "legacy-interleaved",
            wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return input.pickId == 99u; }",
        };

        const regular = makePickerEngine();
        const regularScene = makePickScene(regular.engine);
        regularScene.mesh._gpu = {
            ...regularScene.mesh._gpu,
            _vbLayout: {
                _p: { _stride: 24, _offset: 8 },
            },
        };
        await pickAsync(createGpuPicker(regularScene.scene), 4, 4, { discard });
        const regularShader = regular.device.shaderModules.find((module) => String(module.label).includes("legacy-interleaved-vb"));
        expect(regularShader?.code).toContain(discard.wgsl);
        expect(regularShader?.code).not.toContain("vertexData");

        const thin = makePickerEngine();
        const thinScene = makePickScene(thin.engine);
        thinScene.mesh._gpu = {
            ...thinScene.mesh._gpu,
            _vbLayout: {
                _p: { _stride: 24, _offset: 8 },
            },
        };
        thinScene.mesh.thinInstances = {
            count: 1,
            _gpuBuffer: {} as GPUBuffer,
        } as NonNullable<Mesh["thinInstances"]>;
        await pickAsync(createGpuPicker(thinScene.scene), 4, 4, { discard: { ...discard, key: "legacy-thin-interleaved" } });
        const thinShader = thin.device.shaderModules.find((module) => String(module.label).includes("legacy-thin-interleaved-vb"));
        expect(thinShader?.code).toContain(discard.wgsl);
        expect(thinShader?.code).not.toContain("vertexData");
    });

    it("uploads the selected pixel center in original framebuffer coordinates", async () => {
        const { engine } = makePickerEngine();
        const { scene } = makePickScene(engine);
        scene.camera!.viewport = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
        const writeBuffer = vi.spyOn(engine._device.queue, "writeBuffer");
        const picker = createGpuPicker(scene);

        await pickAsync(picker, 20, 20);

        const sceneWrite = writeBuffer.mock.calls.find((call) => call[2] instanceof Float32Array && call[2].length === 20);
        expect(sceneWrite).toBeDefined();
        expect(Array.from((sceneWrite![2] as Float32Array).subarray(16, 18))).toEqual([20.5, 20.5]);
    });

    it("publishes the selected original framebuffer pixel under DPR and a nonzero viewport", async () => {
        const { engine, writes } = makePickerEngine();
        const { scene } = makePickScene(engine);
        const surface = scene.surface as unknown as { canvas: { width: number; height: number; clientWidth: number; clientHeight: number } };
        surface.canvas = { width: 128, height: 96, clientWidth: 64, clientHeight: 48 };
        (scene.camera as unknown as { viewport: { x: number; y: number; width: number; height: number } }).viewport = {
            x: 0.25,
            y: 0.25,
            width: 0.5,
            height: 0.5,
        };

        await pickAsync(createGpuPicker(scene), 20, 15);

        const sceneWrite = writes.find((write) => write.label === "pick-scene-ubo");
        expect(sceneWrite?.data).toHaveLength(20);
        expect(sceneWrite?.data[16]).toBe(40.5);
        expect(sceneWrite?.data[17]).toBe(30.5);
    });

    it("destroys temporary pick buffers after the pick submission readback completes", async () => {
        const { engine, buffers } = makePickerEngine();
        const { scene } = makePickScene(engine);
        const picker = createGpuPicker(scene);

        await pickAsync(picker, 4, 4);

        const persistentLabels = new Set(["pick-color-staging", "pick-depth-staging", "pick-scene-ubo"]);
        const temporary = buffers.filter(({ descriptor }) => !persistentLabels.has(String(descriptor.label ?? "")));
        expect(temporary.length).toBeGreaterThan(0);
        expect(temporary.every(({ destroy }) => destroy.mock.calls.length === 1)).toBe(true);
        expect(engine._retirements).toHaveLength(0);
    });

    it("loads lazy pick contributors before creating an encoder that can capture replaceable mesh buffers", async () => {
        const { engine } = makePickerEngine();
        const { scene } = makePickScene(engine);
        let resolveLoad!: (pipeline: PickPipelineModule) => void;
        const load = vi.fn(
            () =>
                new Promise<PickPipelineModule>((resolve) => {
                    resolveLoad = resolve;
                })
        );
        const source: PickSource = { entity: {}, load };
        scene._pickSources.push(source);
        const createCommandEncoder = vi.spyOn(engine._device, "createCommandEncoder");
        const picker = createGpuPicker(scene);

        const pendingPick = pickAsync(picker, 4, 4);
        await Promise.resolve();
        await Promise.resolve();

        expect(load).toHaveBeenCalledTimes(1);
        expect(createCommandEncoder).not.toHaveBeenCalled();

        resolveLoad({
            createPickContributor: () => ({
                draw: (_ctx, baseId) => baseId,
                resolve: () => {},
            }),
        });
        await pendingPick;

        expect(createCommandEncoder).toHaveBeenCalledTimes(1);
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
