import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { createGpuPicker, pickAsync } from "../../../packages/babylon-lite/src/picking/gpu-picker";
import { getPickingPipelineSet as getBasicPickingPipelineSet } from "../../../packages/babylon-lite/src/picking/picking-pipeline";
import { getPickingPipelineSet, getPickingRegularPipeline } from "../../../packages/babylon-lite/src/picking/picking-advanced-pipeline";
import { pickingShaderSource } from "../../../packages/babylon-lite/src/picking/picking-shader";
import { pickingShaderVariantSource, pickingThinInstanceShaderSource } from "../../../packages/babylon-lite/src/picking/picking-advanced-shader";
import { enableDetailedPicking } from "../../../packages/babylon-lite/src/picking/detailed-picking";
import { bindVatPickingProjection, getVatPickingProjection } from "../../../packages/babylon-lite/src/picking/vat-picking-pipeline";
import { createVatPickProjectionWgsl } from "../../../packages/babylon-lite/src/material/pbr/fragments/vat-fragment";
import type { PickDiscardRule, PickOptions } from "../../../packages/babylon-lite/src";
import type { PickPipelineModule, PickSource } from "../../../packages/babylon-lite/src/picking/pick-contributor";
import type { StorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function wgslStruct(source: string, name: string): string {
    const start = source.indexOf(`struct ${name} {`);
    const end = source.indexOf("};", start);
    if (start < 0 || end < 0) {
        throw new Error(`Missing WGSL struct ${name}.`);
    }
    return source.slice(start, end + 2);
}

function makeEngine(features: readonly GPUFeatureName[] = ["primitive-index"]): {
    engine: EngineContext;
    device: {
        features: Set<GPUFeatureName>;
        bindGroupLayouts: GPUBindGroupLayoutDescriptor[];
        shaderModules: GPUShaderModuleDescriptor[];
        pipelineLayouts: GPUPipelineLayoutDescriptor[];
        renderPipelines: GPURenderPipelineDescriptor[];
    };
} {
    const device = {
        features: new Set(features),
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
    pass: { drawCalls: { group2Bound: boolean }[]; boundVertexSlots: number[]; setBindGroup(index: number): void };
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
        } else if (descriptor.label === "pick-detail-staging") {
            const u32 = new Uint32Array(data);
            const f32 = new Float32Array(data);
            u32[0] = 0;
            f32[1] = 0;
            f32[2] = 0;
            f32[3] = 0;
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

function attachMockVat(mesh: Mesh, opts: { eightBones?: boolean; instanceTexture?: boolean; instanceStorage?: StorageBuffer } = {}): void {
    const texture = { createView: vi.fn(() => ({ label: "vat-view" })) } as unknown as GPUTexture;
    const instanceTexture = opts.instanceTexture ? ({ createView: vi.fn(() => ({ label: "vat-instance-view" })) } as unknown as GPUTexture) : null;
    mesh.vat = {
        boneCount: 1,
        texture,
        frameCount: 1,
        settingsBuffer: {} as GPUBuffer,
        jointsBuffer: {} as GPUBuffer,
        weightsBuffer: {} as GPUBuffer,
        joints1Buffer: opts.eightBones ? ({} as GPUBuffer) : null,
        weights1Buffer: opts.eightBones ? ({} as GPUBuffer) : null,
        _textureResource: { texture },
        _skinBuffers: {
            jointsBuffer: {} as GPUBuffer,
            weightsBuffer: {} as GPUBuffer,
            joints1Buffer: opts.eightBones ? ({} as GPUBuffer) : null,
            weights1Buffer: opts.eightBones ? ({} as GPUBuffer) : null,
        },
        instanceTexture,
        _instanceStorage: opts.instanceStorage ?? null,
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
        expect(regular).toContain("let wp = (mesh.world * vec4f(position, 1.0)).xyz;");
        expect(regular).toContain("out.hasThinInstance = 0u;");
        expect(regular).toContain("out.thinInstanceIndex = 0xffffffffu;");
        expect(wgslStruct(regular, "PickDiscardInput")).not.toContain("vertexData");
        expect(regular).not.toContain("PickWorldInput");
        expect(regular).toContain("PickDiscardInput(input.worldPos, scene.fragmentCoord");

        expect(thin).toContain("fn shouldDiscardPick(input: PickDiscardInput) -> bool");
        expect(thin).toContain("return false;");
        expect(thin).toContain("let packed = instances[instanceIndex];");
        expect(thin).toContain("let extras = vec4f(packed[0].w, packed[1].w, packed[2].w, packed[3].w);");
        expect(thin).toContain("let wp = adjustPickWorld(");
        expect(thin).toContain("out.hasThinInstance = 1u;");
        expect(thin).toContain("out.thinInstanceIndex = instanceIndex;");
        expect(thin).toContain("out.instanceExtras = extras;");
        expect(wgslStruct(thin, "PickDiscardInput")).not.toContain("vertexData");
        expect(thin).toContain("PickWorldInput");
        expect(thin).toContain("PickDiscardInput(input.worldPos, scene.fragmentCoord");
    });

    describe("VAT picking projection", () => {
        it("uses the exact visible VAT transform as projected world and adjustment basis", () => {
            const regular = createVatPickProjectionWgsl(false);
            const thinTexture = createVatPickProjectionWgsl(true);
            const thinStorage = createVatPickProjectionWgsl(true, true);

            expect(regular.regularBody).toContain("let projectedTransform = mesh.world * influence;");
            expect(regular.regularBody).toContain("let projectedWorld = (projectedTransform * vec4f(position, 1.0)).xyz;");
            expect(thinTexture.thinBody).toContain("let projectedTransform = instanceWorld * tiMesh.world * influence;");
            expect(thinTexture.thinBody).toContain("vatInstanceTex");
            expect(thinStorage.thinBody).toContain("vatInstanceStorage");
            expect(thinStorage.thinBody).toContain("joints1[3]");
        });

        it("builds regular 4-bone and thin 8-bone texture projections with group 3", () => {
            const { engine, device } = makeEngine();
            const { mesh } = makePickScene(engine);
            attachMockVat(mesh);
            const regularProjection = getVatPickingProjection(engine, mesh)!;
            const regularSet = getPickingPipelineSet(engine, null, false, regularProjection);

            expect(regularProjection.key).toBe("vat-4-texture");
            expect(regularProjection.vertexBuffers).toHaveLength(2);
            expect(device.pipelineLayouts.at(-1)?.bindGroupLayouts).toHaveLength(4);
            expect(String(device.shaderModules.at(-2)?.code)).toContain("@group(3) @binding(0) var vatSampler");
            expect(regularSet._vertexProjection).toBe(regularProjection);

            mesh.thinInstances = { count: 1, matrices: IDENTITY, _gpuBuffer: {} as GPUBuffer } as NonNullable<Mesh["thinInstances"]>;
            attachMockVat(mesh, { eightBones: true, instanceTexture: true });
            const thinProjection = getVatPickingProjection(engine, mesh)!;
            getPickingPipelineSet(engine, null, false, thinProjection);

            expect(thinProjection.key).toBe("vat-8-texture");
            expect(thinProjection.vertexBuffers).toHaveLength(4);
            expect(String(device.shaderModules.at(-1)?.code)).toContain("@location(3) joints1: vec4<u32>");
            expect(String(device.shaderModules.at(-1)?.code)).toContain("var vatInstanceTex: texture_2d<f32>");
        });

        it("binds VAT textures and skin attributes after the picker-owned vertex slots", () => {
            const { engine, pass } = makePickerEngine();
            const { mesh } = makePickScene(engine);
            mesh.thinInstances = { count: 1, matrices: IDENTITY, _gpuBuffer: {} as GPUBuffer } as NonNullable<Mesh["thinInstances"]>;
            attachMockVat(mesh, { eightBones: true, instanceTexture: true });
            const projection = getVatPickingProjection(engine, mesh)!;
            const pipeline = getPickingPipelineSet(engine, null, false, projection).thinInstancePipeline;
            const setBindGroup = vi.spyOn(pass, "setBindGroup");

            bindVatPickingProjection(engine, pass as unknown as GPURenderPassEncoder, pipeline, mesh, true, 2);

            expect(setBindGroup).toHaveBeenCalledWith(3, expect.anything());
            expect(pass.boundVertexSlots).toEqual([2, 3, 4, 5]);
        });

        it("binds authoritative per-instance StorageBuffer params and rejects missing thin VAT params", () => {
            const { engine, pass } = makePickerEngine();
            const { mesh } = makePickScene(engine);
            mesh.thinInstances = { count: 1, matrices: IDENTITY, _gpuBuffer: {} as GPUBuffer } as NonNullable<Mesh["thinInstances"]>;
            attachMockVat(mesh);
            expect(getVatPickingProjection(engine, mesh)).toBeNull();

            const raw = {} as GPUBuffer;
            const storage = {
                byteLength: 32,
                _buffer: raw,
                _destroyed: false,
                _data: new Uint8Array(32),
                _engine: engine,
            } as unknown as StorageBuffer;
            engine._storageBuffers = new Set([storage]);
            attachMockVat(mesh, { instanceStorage: storage });
            const projection = getVatPickingProjection(engine, mesh)!;
            const pipeline = getPickingPipelineSet(engine, null, false, projection).thinInstancePipeline;
            const createBindGroup = vi.spyOn(engine._device, "createBindGroup");

            bindVatPickingProjection(engine, pass as unknown as GPURenderPassEncoder, pipeline, mesh, true, 1);

            expect(projection.key).toBe("vat-4-storage");
            expect(createBindGroup).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    entries: expect.arrayContaining([{ binding: 2, resource: { buffer: raw } }]),
                })
            );
        });
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
        expect(thin).toContain("let instanceWorld = mat4x4f(");
        expect(thin).toContain("vec4f(packed[0].xyz, 0.0)");
        expect(thin).toContain("vec4f(packed[3].xyz, 1.0)");
    });

    it("forwards optional regular-mesh vertex data as one flat padded vec4", () => {
        const zero = pickingShaderVariantSource(false, { vertexDataComponents: 0, exposeVertexData: true });
        const uv = pickingShaderVariantSource(false, { vertexDataComponents: 2, exposeVertexData: true });
        const normal = pickingShaderVariantSource(false, { vertexDataComponents: 3, exposeVertexData: true });
        const tangent = pickingShaderVariantSource(false, { vertexDataComponents: 4, exposeVertexData: true });
        const thin = pickingShaderVariantSource(true, { vertexDataComponents: 0, exposeVertexData: true });

        expect(zero).toContain("let vertexPayload = vec4f(0.0);");
        expect(zero).toContain("out.vertexData = vertexPayload;");
        expect(uv).toContain("@location(5) vertexData: vec2f");
        expect(uv).toContain("let vertexPayload = vec4f(vertexData, 0.0, 0.0);");
        expect(normal).toContain("@location(5) vertexData: vec3f");
        expect(normal).toContain("let vertexPayload = vec4f(vertexData, 0.0);");
        expect(tangent).toContain("@location(5) vertexData: vec4f");
        expect(tangent).toContain("let vertexPayload = vertexData;");
        for (const source of [uv, normal, tangent]) {
            expect(source).toContain("@location(5) @interpolate(flat) vertexData: vec4f");
        }
        expect(thin).toContain("out.vertexData = vec4f(0.0);");
    });

    it("injects a custom world adjustment into regular and thin-instance picking shaders", () => {
        const worldAdjustWgsl = `
fn adjustPickWorld(input: PickWorldInput) -> vec3f {
if (input.thinInstanceIndex == 0xffffffffu) { return input.worldPos + input.basis0 * input.vertexData.x; }
return input.worldPos + offsets[input.thinInstanceIndex].xyz + input.instanceExtras.xyz;
}`;
        const options = {
            worldAdjustWgsl,
            storage: [{ name: "offsets", type: "array<vec4f>", vertex: true }],
            vertexDataComponents: 0 as const,
            exposeVertexData: false,
        };

        const regular = pickingShaderVariantSource(false, options);
        const thin = pickingShaderVariantSource(true, options);

        for (const source of [regular, thin]) {
            expect(source).toContain(worldAdjustWgsl);
            expect(source.match(/fn adjustPickWorld/g)).toHaveLength(1);
            expect(source).toContain("@group(2) @binding(0) var<storage, read> offsets: array<vec4f>;");
        }
        expect(regular).toContain("PickWorldInput(projectedWorld, position, projectedTransform[0].xyz");
        expect(regular).toContain("let vertexPayload = vec4f(0.0);");
        expect(regular).toContain("vec4f(0.0), 0xffffffffu, 0u, vertexPayload");
        expect(wgslStruct(regular, "PickDiscardInput")).not.toContain("vertexData");
        expect(wgslStruct(regular, "PickWorldInput")).toContain("vertexData: vec4f");
        expect(thin).toContain("PickWorldInput(projectedWorld, position, projectedTransform[0].xyz");
        expect(thin).toContain("world: mat4x4f");
        expect(thin).toContain("let instanceWorld = mat4x4f(");
        expect(thin).toContain("let world = tiMesh.world * instanceWorld;");
        expect(thin).toContain("extras, instanceIndex, 1u, vec4f(0.0)");
        expect(wgslStruct(thin, "PickDiscardInput")).not.toContain("vertexData");
    });

    it("uses the requested primitive-index feature for detailed variants", () => {
        const basic = pickingShaderVariantSource(false);
        const detailed = pickingShaderVariantSource(false, { detailed: true });

        expect(basic).not.toContain("enable primitive_index;");
        expect(detailed).toContain("enable primitive_index;");
        expect(detailed).toContain("@builtin(primitive_index) primitiveIndex: u32");
        expect(detailed).toContain("@location(2) detail: vec4u");
    });
});

describe("picking discard pipeline API", () => {
    it("allows public discard rules to supply typed-array storage data", () => {
        const discard: PickDiscardRule = {
            key: "public-bindings",
            wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return input.pickId == 1u; }",
            worldAdjustWgsl: "fn adjustPickWorld(input: PickWorldInput) -> vec3f { return input.worldPos; }",
            storage: [{ name: "clipData", type: "array<vec4<f32>>", data: () => new Float32Array(4) }],
            vertexData: "color",
        };
        const options: PickOptions = { discard };

        expect(options.discard).toBe(discard);
        expect(options.discard?.worldAdjustWgsl).toBe(discard.worldAdjustWgsl);
    });

    it("caches the default regular/thin pipeline set per device", () => {
        const { engine, device } = makeEngine();

        const first = getBasicPickingPipelineSet(engine);
        const second = getBasicPickingPipelineSet(engine);

        expect(second).toBe(first);
        expect(first.discardBGL).toBeNull();
        expect(device.renderPipelines).toHaveLength(1);
        expect(device.shaderModules.map((m) => m.label)).toEqual(["picking-shader"]);
        expect(device.pipelineLayouts.every((layout) => Array.from(layout.bindGroupLayouts).length === 2)).toBe(true);
    });

    it("keeps detailed picking inactive when the device lacks primitive-index", () => {
        const { engine, device } = makeEngine([]);
        const { scene } = makePickScene(engine);
        const picker = createGpuPicker(scene);

        enableDetailedPicking(picker);
        const set = getPickingPipelineSet(engine, null, true);

        expect(picker._detailedPicking).toBe(false);
        expect(set.detailed).toBe(false);
        expect(device.renderPipelines.every((pipeline) => Array.from(pipeline.fragment!.targets).length === 2)).toBe(true);
        expect(device.shaderModules.every((module) => !String(module.code).includes("enable primitive_index;"))).toBe(true);
    });

    it("creates a discard pipeline set with a group-2 layout and injected WGSL", () => {
        const { engine, device } = makeEngine();
        const discard = {
            key: "clip-volume",
            wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return clipData[0].x > 0.0 && input.pickId == 7u; }",
            storage: [{ name: "clipData", type: "array<vec4<f32>>", data: () => new Float32Array(4) }],
        };

        const set = getBasicPickingPipelineSet(engine, discard);

        expect(set.discardBGL).not.toBeNull();
        expect(device.bindGroupLayouts.find((layout) => layout.label === "picking-discard-clip-volume-bgl")).toMatchObject({
            label: "picking-discard-clip-volume-bgl",
            entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } }],
        });
        expect(device.renderPipelines).toHaveLength(1);
        expect(device.shaderModules.every((module) => String(module.code).includes(discard.wgsl))).toBe(true);
        expect(device.shaderModules.every((module) => String(module.code).includes("@group(2) @binding(0) var<storage, read> clipData: array<vec4<f32>>;"))).toBe(true);
        expect(device.pipelineLayouts.every((layout) => Array.from(layout.bindGroupLayouts).length === 3)).toBe(true);
    });

    it("creates the requested regular vertex-data pipeline without changing thin-instance layout", () => {
        const { engine, device } = makeEngine();
        const discard: PickDiscardRule = {
            key: "host-id-tangent",
            wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return input.vertexData.x > 0.0; }",
            worldAdjustWgsl: "fn adjustPickWorld(input: PickWorldInput) -> vec3f { return input.worldPos + offsets[0].xyz; }",
            storage: [{ name: "offsets", type: "array<vec4f>", vertex: true, data: () => new Float32Array(4) }],
            vertexData: "tangent",
        };

        const set = getPickingPipelineSet(engine, discard);
        getPickingRegularPipeline(engine, set, discard, undefined, { attribute: "tangent" });

        expect(device.renderPipelines).toHaveLength(3);
        const dataPipelineDescriptor = device.renderPipelines.find((pipeline) => Array.from(pipeline.vertex.buffers ?? []).length === 2)!;
        expect(dataPipelineDescriptor.vertex.buffers).toEqual([
            { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
            { arrayStride: 16, attributes: [{ shaderLocation: 5, offset: 0, format: "float32x4" }] },
        ]);
        const thinPipeline = device.renderPipelines.find((pipeline) => pipeline.label === "picking-ti-host-id-tangent-affine-pipeline")!;
        expect(thinPipeline.vertex.buffers).toHaveLength(1);
        expect(device.bindGroupLayouts.find((layout) => layout.label === "picking-discard-host-id-tangent-bgl")).toMatchObject({
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT }],
        });
    });

    it("uploads the base mesh world matrix for thin-instance vertex-stage picking", async () => {
        const { engine, writes } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        const world = new Float32Array(IDENTITY);
        world[12] = 2;
        world[13] = 3;
        world[14] = 4;
        (mesh as unknown as { worldMatrix: Float32Array }).worldMatrix = world;
        mesh.thinInstances = {
            count: 1,
            matrices: IDENTITY,
            _gpuBuffer: {} as GPUBuffer,
        } as NonNullable<Mesh["thinInstances"]>;
        const discard: PickDiscardRule = {
            key: "thin-world-adjust",
            wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return false; }",
            worldAdjustWgsl: "fn adjustPickWorld(input: PickWorldInput) -> vec3f { return input.worldPos; }",
        };

        await pickAsync(createGpuPicker(scene), 4, 4, { discard });

        const write = writes.find((entry) => entry.label === "pick-thin-instance-ubo");
        expect(write?.data).toHaveLength(20);
        expect(Array.from(write!.data.subarray(0, 16))).toEqual(Array.from(world));
        expect(new Uint32Array(write!.data.buffer)[16]).toBe(1);
        expect(new Uint32Array(write!.data.buffer)[17]).toBe(0);
        expect(new Uint32Array(write!.data.buffer)[18]).toBe(0);
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

    it("decodes GPU primitive and local-position detail for world-adjusted picks", async () => {
        const { engine } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        mesh._cpuPositions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
        mesh._cpuNormals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
        mesh._cpuIndices = new Uint32Array([0, 1, 2]);
        const picker = createGpuPicker(scene);
        enableDetailedPicking(picker);
        const discard: PickDiscardRule = {
            key: "detailed-world-adjust",
            wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return false; }",
            worldAdjustWgsl: "fn adjustPickWorld(input: PickWorldInput) -> vec3f { return input.worldPos; }",
        };

        const info = await pickAsync(picker, 4, 4, { discard });

        expect(info.hit).toBe(true);
        expect(info.pickedPoint).not.toBeNull();
        expect(info.ray).not.toBeNull();
        expect(info.faceId).toBe(0);
        expect(info.bu).toBeCloseTo(0.25);
        expect(info.bv).toBeCloseTo(0.25);
        expect(info.pickedNormal).toBeNull();
        expect(info.pickedFaceNormal).toBeNull();
        expect(info._normalsInvalid).toBe(true);
        const ray = info.ray!;
        const dx = info.pickedPoint![0] - ray.origin[0];
        const dy = info.pickedPoint![1] - ray.origin[1];
        const dz = info.pickedPoint![2] - ray.origin[2];
        expect(Math.abs(dy * ray.direction[2] - dz * ray.direction[1])).toBeLessThan(1e-5);
        expect(Math.abs(dz * ray.direction[0] - dx * ray.direction[2])).toBeLessThan(1e-5);
        expect(Math.abs(dx * ray.direction[1] - dy * ray.direction[0])).toBeLessThan(1e-5);
    });

    it("resolves mesh ids from the submitted draw snapshot", async () => {
        const { engine } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        const second = {
            ...mesh,
            name: "second",
            _gpu: { ...mesh._gpu },
        } as Mesh;
        scene.meshes.push(second);

        const pending = pickAsync(createGpuPicker(scene), 4, 4);
        await Promise.resolve();
        mesh.visible = false;
        scene.meshes.reverse();
        const info = await pending;

        expect(info.pickedMesh).toBe(mesh);
    });

    it("strips packed thin-instance w lanes when transforming detailed normals", async () => {
        const { engine } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        const world = new Float32Array(IDENTITY);
        world[12] = 10;
        (mesh as unknown as { worldMatrix: Float32Array }).worldMatrix = world;
        mesh._cpuPositions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
        mesh._cpuNormals = new Float32Array([1, 1, 0, 1, 1, 0, 1, 1, 0]);
        mesh._cpuIndices = new Uint32Array([0, 1, 2]);
        const packed = new Float32Array(IDENTITY);
        packed[3] = 2;
        mesh.thinInstances = {
            count: 1,
            matrices: packed,
            _gpuBuffer: {} as GPUBuffer,
        } as NonNullable<Mesh["thinInstances"]>;
        const picker = createGpuPicker(scene);
        enableDetailedPicking(picker);

        const info = await pickAsync(picker, 4, 4);

        expect(Math.abs(info.pickedNormalWorld![0])).toBeCloseTo(Math.SQRT1_2);
        expect(Math.abs(info.pickedNormalWorld![1])).toBeCloseTo(Math.SQRT1_2);
    });

    it("preserves source vertex normal semantics for detailed morph picks", async () => {
        const { engine } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        mesh._cpuPositions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
        mesh._cpuNormals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
        mesh._cpuIndices = new Uint32Array([0, 1, 2]);
        mesh.morphTargets = {
            count: 1,
            targets: [
                {
                    positions: new Float32Array(9),
                    normals: new Float32Array([1, 0, -1, 1, 0, -1, 1, 0, -1]),
                },
            ],
            weights: new Float32Array([1]),
            deltasBuffer: {} as GPUBuffer,
            weightsBuffer: {} as GPUBuffer,
        };
        const picker = createGpuPicker(scene);
        enableDetailedPicking(picker);

        const info = await pickAsync(picker, 4, 4);

        expect(Math.abs(info.pickedNormal![0])).toBeCloseTo(0);
        expect(Math.abs(info.pickedNormal![2])).toBeCloseTo(1);
    });

    it("uses deformed positions for morphed thin-instance picks", async () => {
        const { engine, buffers } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        mesh._cpuPositions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
        mesh.morphTargets = {
            count: 1,
            targets: [{ positions: new Float32Array(9), normals: null }],
            weights: new Float32Array([1]),
            deltasBuffer: {} as GPUBuffer,
            weightsBuffer: {} as GPUBuffer,
        };
        mesh.thinInstances = {
            count: 1,
            matrices: IDENTITY,
            _gpuBuffer: {} as GPUBuffer,
            _version: 1,
        } as NonNullable<Mesh["thinInstances"]>;

        await pickAsync(createGpuPicker(scene), 4, 4);

        expect(buffers.some(({ descriptor }) => descriptor.label === "pick-deformed-position")).toBe(true);
    });

    it("suppresses thin-instance detail if instance transforms change during readback", async () => {
        const { engine } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        mesh._cpuPositions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
        mesh._cpuNormals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
        mesh._cpuIndices = new Uint32Array([0, 1, 2]);
        mesh.thinInstances = {
            count: 1,
            matrices: IDENTITY,
            _gpuBuffer: {} as GPUBuffer,
            _version: 1,
        } as NonNullable<Mesh["thinInstances"]>;
        const picker = createGpuPicker(scene);
        enableDetailedPicking(picker);

        const pending = pickAsync(picker, 4, 4);
        await new Promise((resolve) => setTimeout(resolve, 0));
        mesh.thinInstances._version++;
        const info = await pending;

        expect(info.hit).toBe(true);
        expect(info.faceId).toBe(-1);
        expect(info.pickedNormal).toBeNull();
    });

    it("passes the ignored thin-instance identity to the GPU shader", async () => {
        const { engine, writes } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        mesh.thinInstances = {
            count: 2,
            matrices: new Float32Array(32),
            _gpuBuffer: {} as GPUBuffer,
        } as NonNullable<Mesh["thinInstances"]>;

        await pickAsync(createGpuPicker(scene), 4, 4, { ignore: { mesh, thinInstanceIndex: 1 } });

        const write = writes.find((entry) => entry.label === "pick-thin-instance-ubo");
        expect(new Uint32Array(write!.data.buffer)[17]).toBe(1);
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

    it("does not materialize lazy CPU geometry for a basic non-deformed pick", async () => {
        const { engine } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        const positions = vi.fn(() => new Float32Array(9));
        const normals = vi.fn(() => new Float32Array(9));
        Object.defineProperty(mesh, "_cpuPositions", { configurable: true, get: positions });
        Object.defineProperty(mesh, "_cpuNormals", { configurable: true, get: normals });

        await pickAsync(createGpuPicker(scene), 4, 4);

        expect(positions).not.toHaveBeenCalled();
        expect(normals).not.toHaveBeenCalled();
    });

    it("keeps invisible pickable collider meshes in the GPU pick pass", async () => {
        const { engine } = makePickerEngine();
        const { scene, mesh } = makePickScene(engine);
        mesh.visible = false;

        const info = await pickAsync(createGpuPicker(scene), 4, 4);

        expect(info.hit).toBe(true);
        expect(info.pickedMesh).toBe(mesh);
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

        const dataPipeline = device.renderPipelines.find((pipeline) => Array.from(pipeline.vertex.buffers ?? []).length === 2);
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
        const regularShader = regular.device.shaderModules.find((module) => String(module.label).includes("picking-vb-") && String(module.code).includes(discard.wgsl));
        expect(regularShader?.code).toContain(discard.wgsl);
        expect(wgslStruct(String(regularShader?.code), "PickDiscardInput")).not.toContain("vertexData");

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
        const thinShader = thin.device.shaderModules.find((module) => String(module.label).includes("picking-ti-vb-") && String(module.code).includes(discard.wgsl));
        expect(thinShader?.code).toContain(discard.wgsl);
        expect(wgslStruct(String(thinShader?.code), "PickDiscardInput")).not.toContain("vertexData");
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

    it("recreates picker-owned resources when the engine device changes", async () => {
        const first = makePickerEngine();
        const { scene } = makePickScene(first.engine);
        const picker = createGpuPicker(scene);
        await pickAsync(picker, 4, 4);

        const second = makePickerEngine();
        first.engine._device = second.engine._device;
        await pickAsync(picker, 4, 4);

        const persistentLabels = new Set(["pick-color", "pick-depth-color", "pick-depth", "pick-color-staging", "pick-depth-staging", "pick-scene-ubo"]);
        const firstPersistent = first.buffers.filter(({ descriptor }) => persistentLabels.has(String(descriptor.label ?? "")));
        expect(firstPersistent.length).toBeGreaterThan(0);
        expect(firstPersistent.every(({ destroy }) => destroy.mock.calls.length === 1)).toBe(true);
        expect(picker._device).toBe(second.engine._device);
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

        getBasicPickingPipelineSet(first.engine);
        getBasicPickingPipelineSet(second.engine);

        expect(first.device.renderPipelines).toHaveLength(1);
        expect(second.device.renderPipelines).toHaveLength(1);
    });
});
