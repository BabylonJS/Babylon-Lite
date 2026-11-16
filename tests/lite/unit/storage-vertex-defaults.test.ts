import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { createShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { buildShaderGroup, buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { setShaderAttributeFormats } from "../../../packages/babylon-lite/src/material/shader/shader-vb";
import { enableShaderMaterialFinalColor } from "../../../packages/babylon-lite/src/material/shader/enable-shader-material-final-color";
import { createMeshFromStorageBuffer } from "../../../packages/babylon-lite/src/mesh/mesh-from-storage";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { createMeshFromData } from "../../../packages/babylon-lite/src/mesh/mesh-factories";
import { disposeMeshGpu } from "../../../packages/babylon-lite/src/mesh/mesh-dispose";
import { setThinInstances } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import { createStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { cloneTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import { createBuildState } from "../../../packages/babylon-lite/src/material/node/node-emitter";
import { compileNodePipeline } from "../../../packages/babylon-lite/src/material/node/node-pipeline";
import { getAttrBuffer as getNodeAttributeBuffer } from "../../../packages/babylon-lite/src/material/node/node-renderable";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";

function fixture() {
    const created: GPUBuffer[] = [];
    const device = {
        limits: { maxBufferSize: 256 * 1024 * 1024 },
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const mapped = descriptor.mappedAtCreation ? new ArrayBuffer(Number(descriptor.size)) : null;
            const buffer = {
                label: descriptor.label,
                size: Number(descriptor.size),
                usage: descriptor.usage,
                destroy: vi.fn(),
                unmap: vi.fn(),
                getMappedRange: () => {
                    if (!mapped) throw new Error("buffer was not mapped");
                    return mapped;
                },
            } as unknown as GPUBuffer;
            created.push(buffer);
            return buffer;
        }),
        createBindGroupLayout: (descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout,
        createBindGroup: (descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup,
        createPipelineLayout: (descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout,
        createShaderModule: (descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule,
        createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline,
        queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    const engine = { _device: device, canvas: { width: 64, height: 64 } } as EngineContext;
    const scene = { surface: { engine }, camera: null, _meshDisposables: new Map(), _meshAuxDisposables: new Map() } as unknown as SceneContext;
    const pass = { setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), setBindGroup: vi.fn(), drawIndexed: vi.fn(), drawIndexedIndirect: vi.fn() };
    return { engine, scene, created, pass };
}

const signature: RenderTargetSignature = { _colorFormat: "rgba8unorm", _sampleCount: 1 };

function material() {
    const result = createShaderMaterial({
        attributes: ["position", "color", "tangent", "uv2", "joints", "weights"],
        vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f {
return vec4f(input.position + input.color.x + input.tangent.x + input.uv2.x + f32(input.joints.x) + input.weights.x, 0, 0, 1);
}`,
        fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
    });
    setShaderAttributeFormats(result, { position: "float32", color: "unorm8x4", joints: "uint16x4" });
    return result;
}

function pipelineLayouts(pipeline: GPURenderPipeline) {
    return (pipeline as unknown as GPURenderPipelineDescriptor).vertex.buffers as readonly GPUVertexBufferLayout[];
}

describe("storage-backed missing vertex attributes", () => {
    it.each(["interleaved", "tight", "empty"] as const)("sizes legacy %s defaults from vertex count rather than shared allocation size", (kind) => {
        const f = fixture();
        const count = kind === "empty" ? 0 : 3;
        const mesh = createMeshFromData(
            f.engine,
            "legacy-default",
            new Float32Array(count * 3),
            new Float32Array(count * 3),
            count ? new Uint32Array([0, 1, 2]) : new Uint32Array()
        );
        if (kind === "interleaved") {
            Object.assign(mesh._gpu, {
                positionBuffer: { size: 4096 } as GPUBuffer,
                _vbLayout: { position: { _stride: 32, _offset: 0, _count: count } },
                _vbKey: "interleaved-default",
            });
        }
        const expectedBytes = Math.max(count * 16, 4);
        const nodeDefault = getNodeAttributeBuffer(f.engine, mesh._gpu, "color");
        expect(nodeDefault.size).toBe(expectedBytes);
        expect(getNodeAttributeBuffer(f.engine, mesh._gpu, "color")).toBe(nodeDefault);

        const shader = createShaderMaterial({
            attributes: ["position", "color"],
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position,1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
        });
        setShaderAttributeFormats(shader, {});
        mesh.material = shader;
        const binding = buildShaderMaterialRenderables(f.scene, [mesh]).renderables[0]!.bind(f.engine, signature);
        binding.draw(f.pass as unknown as GPURenderPassEncoder, f.engine);
        const shaderDefault = f.created.find((buffer) => buffer.label === "shader-zero-color")!;
        expect(shaderDefault.size).toBe(expectedBytes);
        expect(f.pass.setVertexBuffer).toHaveBeenCalledWith(1, shaderDefault);
    });

    it.each([false, true])("uses a neutral constant white stream for packed final-color inputs (thin=%s)", async (thin) => {
        const f = fixture();
        const shader = createShaderMaterial({
            attributes: ["position", "color"],
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f {
return vec4f(input.position.xyz * getFinalColor(input).rgb, 1);
}`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
        });
        setShaderAttributeFormats(shader, { position: "float32x4", color: "unorm8x4" });
        enableShaderMaterialFinalColor(shader);
        const storage = createStorageBuffer(f.engine, 160048, { vertex: true });
        const mesh = createMeshFromStorageBuffer(f.engine, "white-slot", {
            storage,
            indices: new Uint16Array([0, 1, 2]),
            vertexCount: 3,
            arrayStride: 16,
            baseVertex: 10000,
        });
        mesh.material = shader;
        if (thin) {
            setThinInstances(mesh, new Float32Array(16), 1);
        }
        const built = thin ? await buildShaderGroup(f.scene, [mesh]) : buildShaderMaterialRenderables(f.scene, [mesh]);
        const binding = built.renderables[0]!.bind(f.engine, signature);
        binding.update?.({ targetWidth: 64, targetHeight: 64 });
        binding.draw(f.pass as unknown as GPURenderPassEncoder, f.engine);
        const colorLayout = pipelineLayouts(binding.pipeline)[1]!;
        expect(colorLayout.arrayStride).toBe(0);
        expect(colorLayout.attributes[0]!.format).toBe("float32x4");
        const white = mesh._gpu._shaderColorFallback!;
        expect(white.size).toBe(16);
        expect(Array.from(new Float32Array(white.getMappedRange()))).toEqual([1, 1, 1, 1]);
        expect(f.pass.setVertexBuffer).toHaveBeenCalledWith(1, white);

        const clone = cloneTransformNode(mesh) as Mesh;
        disposeMeshGpu(mesh);
        expect(white.destroy).not.toHaveBeenCalled();
        disposeMeshGpu(clone);
        expect(white.destroy).toHaveBeenCalledOnce();
        expect(storage._buffer!.destroy).not.toHaveBeenCalled();
    });

    it("prevalidates every mesh before allocating a group and preserves the minimum opaque render order", () => {
        const f = fixture();
        const shader = createShaderMaterial({
            attributes: ["position"],
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position,1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
        });
        const meshes = [10, -5, 20].map((renderOrder) => {
            const mesh = createMeshFromStorageBuffer(f.engine, "ordered", {
                storage: createStorageBuffer(f.engine, 48, { vertex: true }),
                indices: new Uint16Array([0, 1, 2]),
                vertexCount: 3,
                arrayStride: 16,
            });
            mesh.material = shader;
            mesh.renderOrder = renderOrder;
            return mesh;
        });
        expect(buildShaderMaterialRenderables(f.scene, meshes).renderables[0]!.order).toBe(-5);
        const incompatibleShader = createShaderMaterial({
            attributes: ["position"],
            vertexSource: shader.vertexSource,
            fragmentSource: shader.fragmentSource,
        });
        setShaderAttributeFormats(incompatibleShader, { position: "float32x4" });
        meshes[0]!.material = incompatibleShader;
        const incompatible = createMeshFromData(f.engine, "cpu", new Float32Array(9), new Float32Array(9), new Uint32Array([0, 1, 2]));
        incompatible.material = incompatibleShader;
        const created = f.created.length;
        expect(() => buildShaderMaterialRenderables(f.scene, [meshes[0]!, incompatible])).toThrow(/incompatible with canonical/);
        expect(f.created).toHaveLength(created);
    });

    it.each(["position", "uv2"] as const)("rejects noncanonical %s on CPU geometry, including missing canonical streams", (attribute) => {
        const f = fixture();
        const shader = createShaderMaterial({
            attributes: ["position", "uv2"],
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(0,0,0,1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
        });
        setShaderAttributeFormats(shader, { [attribute]: "float32x4" });
        const mesh = createMeshFromData(f.engine, "cpu", new Float32Array(9), new Float32Array(9), new Uint32Array([0, 1, 2]));
        mesh.material = shader;
        const created = f.created.length;
        expect(() => buildShaderMaterialRenderables(f.scene, [mesh])).toThrow(/float32x4.*incompatible.*cpu/);
        expect(f.created).toHaveLength(created);
    });

    it("allows one material to share compatible formats across CPU and differently packed storage geometry", () => {
        const f = fixture();
        const shader = createShaderMaterial({
            attributes: ["position"],
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position,1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
        });
        setShaderAttributeFormats(shader, { position: "float32x3" });
        const cpu = createMeshFromData(f.engine, "cpu", new Float32Array(9), new Float32Array(9), new Uint32Array([0, 1, 2]));
        const storage = createStorageBuffer(f.engine, 60, { vertex: true });
        const packed = createMeshFromStorageBuffer(f.engine, "packed", {
            storage,
            indices: new Uint16Array([0, 1, 2]),
            vertexCount: 3,
            arrayStride: 20,
            attributeOffsets: { position: 4 },
        });
        cpu.material = packed.material = shader;
        const built = buildShaderMaterialRenderables(f.scene, [cpu, packed]);
        expect(built.renderables).toHaveLength(2);
        const layouts = built.renderables.map((renderable) => pipelineLayouts(renderable.bind(f.engine, signature).pipeline)[0]!);
        expect(layouts.map((layout) => layout.arrayStride)).toEqual([12, 20]);
        expect(layouts.map((layout) => layout.attributes[0]!.offset)).toEqual([0, 4]);
        expect(layouts.map((layout) => layout.attributes[0]!.format)).toEqual(["float32x3", "float32x3"]);
    });

    it.each([
        ["float32x4", 12, 0],
        ["float32x3", 16, 2],
    ] as const)("rejects format/layout mismatch %s at stride %s offset %s", (format, arrayStride, offset) => {
        const f = fixture();
        const shader = createShaderMaterial({
            attributes: ["position"],
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(0,0,0,1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
        });
        setShaderAttributeFormats(shader, { position: format });
        const mesh = createMeshFromStorageBuffer(f.engine, "misaligned", {
            storage: createStorageBuffer(f.engine, arrayStride * 3, { vertex: true }),
            indices: new Uint16Array([0, 1, 2]),
            vertexCount: 3,
            arrayStride,
            attributeOffsets: { position: offset },
        });
        mesh.material = shader;
        const created = f.created.length;
        expect(() => buildShaderMaterialRenderables(f.scene, [mesh])).toThrow(/does not fit the aligned vertex layout/);
        expect(f.created).toHaveLength(created);
    });

    it("accepts narrow integer fields with their actual two-byte alignment and snapshots format declarations", () => {
        const f = fixture();
        const shader = createShaderMaterial({
            attributes: ["position"],
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(0,0,0,1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
        });
        const formats: { position: GPUVertexFormat } = { position: "uint8x2" };
        setShaderAttributeFormats(shader, formats);
        formats.position = "float32x4";
        const mesh = createMeshFromStorageBuffer(f.engine, "narrow", {
            storage: createStorageBuffer(f.engine, 12, { vertex: true }),
            indices: new Uint16Array([0, 1, 2]),
            vertexCount: 3,
            arrayStride: 4,
            attributeOffsets: { position: 2 },
        });
        mesh.material = shader;
        const pipeline = buildShaderMaterialRenderables(f.scene, [mesh]).renderables[0]!.bind(f.engine, signature).pipeline;
        expect(pipelineLayouts(pipeline)[0]).toEqual({
            arrayStride: 4,
            attributes: [{ shaderLocation: 0, offset: 2, format: "uint8x2" }],
        });
    });

    it.each([
        [0, undefined, undefined, undefined],
        [1, "src-alpha", "one", "one"],
        [2, "src-alpha", "one-minus-src-alpha", "one"],
        [7, "one", "one-minus-src-alpha", "one-minus-src-alpha"],
        [9, undefined, undefined, undefined],
    ] as const)("preserves Node blend, depth and entry points in canonical and packed variants (mode %s)", (mode, srcFactor, colorDstFactor, alphaDstFactor) => {
        const f = fixture();
        const mesh = createMeshFromStorageBuffer(f.engine, "node-state", {
            storage: createStorageBuffer(f.engine, 64, { vertex: true }),
            indices: new Uint16Array([0, 1, 2]),
            vertexCount: 3,
            arrayStride: 16,
        });
        const state = createBuildState();
        state.vertexAttributes.push({ _name: "position", _type: "vec3<f32>", _gpuFormat: "float32x3", _arrayStride: 12 });
        state.nodeUboFields.push({ _name: "tint", _type: "vec4<f32>" });
        const compiled = compileNodePipeline(state, "out.position = vec4<f32>(in.position, 1.0);", "_NME_FRAG_OUTPUT_ = vec4<f32>(1.0);", {
            _engine: f.engine,
            _format: "rgba8unorm",
            _msaaSamples: 4,
            _alphaMode: mode,
            _depthStencilFormat: "depth32float",
            _depthCompare: "less-equal",
            _backFaceCulling: false,
        });
        const target: GPUColorTargetState = { format: "rgba8unorm" };
        if (srcFactor && colorDstFactor && alphaDstFactor) {
            target.blend = {
                color: { srcFactor, dstFactor: colorDstFactor, operation: "add" },
                alpha: { srcFactor: "one", dstFactor: alphaDstFactor, operation: "add" },
            };
        }
        for (const pipeline of [compiled._pipeline, compiled._pipelineForMesh(mesh._gpu)]) {
            const descriptor = pipeline as unknown as GPURenderPipelineDescriptor;
            expect(descriptor.layout).toBe((compiled._pipeline as unknown as GPURenderPipelineDescriptor).layout);
            expect(descriptor.vertex.entryPoint).toBe("vs_main");
            expect(descriptor.fragment!.entryPoint).toBe("fs_main");
            expect(descriptor.fragment!.targets).toEqual([target]);
            expect(descriptor.multisample).toEqual({ count: 4 });
            expect(descriptor.primitive?.cullMode).toBe("none");
            expect(descriptor.depthStencil).toEqual({ format: "depth32float", depthCompare: "less-equal", depthWriteEnabled: !srcFactor });
        }
        expect(compiled._wgsl).toContain("    tint: vec4<f32>,");
        expect(compiled._nodeUboSpec!._offsets.get("tint")).toBe(0);
        expect(compiled._nodeUboSpec!._totalBytes).toBe(16);
    });

    it("owns defaults per engine, replaces them after recovery, and releases the current generation", () => {
        const first = fixture();
        const second = fixture();
        const meshFor = (engine: EngineContext) =>
            createMeshFromStorageBuffer(engine, "defaults", {
                storage: createStorageBuffer(engine, 64, { vertex: true }),
                indices: new Uint16Array([0, 1, 2]),
                vertexCount: 3,
                arrayStride: 16,
            });
        const mesh = meshFor(first.engine);
        const otherMesh = meshFor(second.engine);
        const original = getNodeAttributeBuffer(first.engine, mesh._gpu, "color");
        expect(getNodeAttributeBuffer(first.engine, mesh._gpu, "tangent")).toBe(original);
        const other = getNodeAttributeBuffer(second.engine, otherMesh._gpu, "color");
        expect(other).not.toBe(original);
        Object.assign(first.engine, { _device: fixture().engine._device });
        const recovered = getNodeAttributeBuffer(first.engine, mesh._gpu, "color");
        expect(recovered).not.toBe(original);
        expect(original.destroy).toHaveBeenCalledOnce();
        expect(other.destroy).not.toHaveBeenCalled();
        first.engine._disposeManagedResources!();
        expect(recovered.destroy).toHaveBeenCalledOnce();
        expect(original.destroy).toHaveBeenCalledOnce();
        const replacement = getNodeAttributeBuffer(first.engine, mesh._gpu, "color");
        expect(replacement).not.toBe(recovered);
        first.engine._disposeManagedResources!();
        expect(replacement.destroy).toHaveBeenCalledOnce();
        second.engine._disposeManagedResources!();
        expect(other.destroy).toHaveBeenCalledOnce();
    });

    it("resolves Node layouts enabled after material compilation and keeps variants device-local", async () => {
        vi.resetModules();
        const [{ compileNodePipeline: compile }, { createMeshFromStorageBuffer: createMesh }, { createStorageBuffer: createStorage }] = await Promise.all([
            import("../../../packages/babylon-lite/src/material/node/node-pipeline"),
            import("../../../packages/babylon-lite/src/mesh/mesh-from-storage"),
            import("../../../packages/babylon-lite/src/resource/storage-buffer"),
        ]);
        const first = fixture();
        const second = fixture();
        const state = createBuildState();
        state.vertexAttributes.push({ _name: "position", _type: "vec3<f32>", _gpuFormat: "float32x3", _arrayStride: 12 });
        const compileFor = (engine: EngineContext) =>
            compile(state, "out.position = vec4<f32>(in.position, 1.0);", "_NME_FRAG_OUTPUT_ = vec4<f32>(1.0);", {
                _engine: engine,
                _format: "rgba8unorm",
                _msaaSamples: 1,
            });
        const compiled = compileFor(first.engine);
        expect(compiled._nodeUboSpec).toBeNull();
        expect(compiled._nodeUboBinding).toBeNull();
        const storage = createStorage(first.engine, 64, { vertex: true });
        const mesh = createMesh(first.engine, "late-node", { storage, indices: new Uint16Array([0, 1, 2]), vertexCount: 3, arrayStride: 16 });
        const pipeline = compiled._pipelineForMesh(mesh._gpu);
        expect(pipeline).not.toBe(compiled._pipeline);
        expect(pipelineLayouts(pipeline)[0]!.arrayStride).toBe(16);
        expect(compiled._pipelineForMesh(mesh._gpu)).toBe(pipeline);
        const other = compileFor(second.engine)._pipelineForMesh(mesh._gpu);
        expect(other).not.toBe(pipeline);
        expect(pipelineLayouts(other)).toEqual(pipelineLayouts(pipeline));
    });

    it.each([4, 8, 16, 64])("uses one tiny default buffer for large slab slots with stride %s", (arrayStride) => {
        const f = fixture();
        const storage = createStorageBuffer(f.engine, 64 * 1024 * 1024, { writable: true, vertex: true });
        const shader = material();
        const meshes = [0, 10000, 1000000].map((baseVertex) => {
            const mesh = createMeshFromStorageBuffer(f.engine, "slot", { storage, indices: new Uint16Array([0, 1, 2]), vertexCount: 3, arrayStride, baseVertex });
            mesh.material = shader;
            expect(mesh._gpu._vertexCount).toBe(3);
            return mesh;
        });
        const clone = cloneTransformNode(meshes[2]!) as Mesh;
        expect(clone._gpu).toBe(meshes[2]!._gpu);
        const built = buildShaderMaterialRenderables(f.scene, [...meshes, clone]);
        expect(built.renderables).toHaveLength(1);
        const binding = built.renderables[0]!.bind(f.engine, signature);
        const layouts = pipelineLayouts(binding.pipeline);
        expect(layouts[0]!.arrayStride).toBe(arrayStride);
        for (const layout of layouts.slice(1)) {
            expect(layout.arrayStride).toBe(0);
            expect(layout.attributes[0]!.offset).toBe(0);
        }
        binding.draw(f.pass as unknown as GPURenderPassEncoder, f.engine);
        const defaults = f.created.filter((buffer) => /zero/.test(buffer.label));
        expect(defaults).toHaveLength(1);
        expect(defaults[0]!.size).toBe(16);
        for (const [slot, buffer] of f.pass.setVertexBuffer.mock.calls) {
            if (slot !== 0) expect(buffer).toBe(defaults[0]);
        }
        expect(f.pass.drawIndexed.mock.calls.map((call) => call[3] ?? 0)).toEqual([0, 10000, 1000000, 1000000]);
        f.engine._disposeManagedResources!();
        expect(defaults[0]!.destroy).toHaveBeenCalledOnce();
        expect(storage._buffer!.destroy).not.toHaveBeenCalled();
    });

    it("does not under-allocate defaults for a compact scalar-position allocation", () => {
        const f = fixture();
        const storage = createStorageBuffer(f.engine, 12, { writable: true, vertex: true });
        const mesh = createMeshFromStorageBuffer(f.engine, "compact", { storage, indices: new Uint16Array([0, 1, 2]), vertexCount: 3, arrayStride: 4 });
        mesh.material = material();
        const binding = buildShaderMaterialRenderables(f.scene, [mesh]).renderables[0]!.bind(f.engine, signature);
        binding.draw(f.pass as unknown as GPURenderPassEncoder, f.engine);
        const layouts = pipelineLayouts(binding.pipeline);
        const tangent = f.pass.setVertexBuffer.mock.calls.find(([slot]) => slot === 2)![1] as GPUBuffer;
        expect(tangent.size).toBeGreaterThanOrEqual((mesh._gpu._vertexCount! - 1) * layouts[2]!.arrayStride + 16);
        expect(tangent.size).toBe(16);
    });

    it("separates merged groups when authored skin streams differ", () => {
        const f = fixture();
        const storage = createStorageBuffer(f.engine, 64, { writable: true, vertex: true });
        const shader = material();
        setShaderAttributeFormats(shader, { position: "float32", color: "unorm8x4", joints: "uint32x4" });
        const meshes = [0, 1].map(() => {
            const mesh = createMeshFromStorageBuffer(f.engine, "skin", { storage, indices: new Uint16Array([0, 1, 2]), vertexCount: 3, arrayStride: 4 });
            mesh.material = shader;
            return mesh;
        });
        meshes[1]!.skeleton = { jointsBuffer: {} as GPUBuffer, weightsBuffer: {} as GPUBuffer } as Mesh["skeleton"];
        const built = buildShaderMaterialRenderables(f.scene, meshes);
        expect(built.renderables).toHaveLength(2);
        const missing = built.renderables[0]!.bind(f.engine, signature).pipeline;
        const present = built.renderables[1]!.bind(f.engine, signature).pipeline;
        expect(present).not.toBe(missing);
        expect(pipelineLayouts(missing)[4]!.arrayStride).toBe(0);
        expect(pipelineLayouts(present)[4]!.arrayStride).toBe(16);
        expect(pipelineLayouts(present)[5]!.arrayStride).toBe(16);
    });

    it("uses the same zero-stride contract for thin-instance pipelines", async () => {
        const f = fixture();
        const storage = createStorageBuffer(f.engine, 4 * 1000010, { writable: true, vertex: true });
        const mesh = createMeshFromStorageBuffer(f.engine, "thin", { storage, indices: new Uint16Array([0, 1, 2]), vertexCount: 3, baseVertex: 1000000, arrayStride: 4 });
        mesh.material = material();
        setThinInstances(mesh, new Float32Array(32), 2);
        const built = await buildShaderGroup(f.scene, [mesh]);
        const binding = built.renderables[0]!.bind(f.engine, signature);
        const layouts = pipelineLayouts(binding.pipeline);
        for (const layout of layouts.slice(1, 6)) expect(layout.arrayStride).toBe(0);
        expect(layouts[6]!.stepMode).toBe("instance");
        expect(layouts[6]!.arrayStride).toBe(64);
        binding.update?.({ targetWidth: 16, targetHeight: 16 });
        binding.draw(f.pass as unknown as GPURenderPassEncoder, f.engine);
        expect(f.created.filter((buffer) => /zero/.test(buffer.label)).map((buffer) => buffer.size)).toEqual([16]);
    });

    it("shares constant defaults with NodeMaterial and honors a nonzero base vertex", () => {
        const f = fixture();
        const storage = createStorageBuffer(f.engine, 16 * 1000010, { writable: true, vertex: true });
        const mesh = createMeshFromStorageBuffer(f.engine, "node", { storage, indices: new Uint16Array([0, 1, 2]), vertexCount: 3, baseVertex: 1000000, arrayStride: 16 });
        const state = createBuildState();
        state.vertexAttributes.push(
            { _name: "position", _type: "vec3<f32>", _gpuFormat: "float32x3", _arrayStride: 12 },
            { _name: "color", _type: "vec4<f32>", _gpuFormat: "float32x4", _arrayStride: 16 }
        );
        const compiled = compileNodePipeline(state, "out.position = vec4<f32>(in.position + in.color.xyz, 1.0);", "_NME_FRAG_OUTPUT_ = vec4<f32>(1.0);", {
            _engine: f.engine,
            _format: "rgba8unorm",
            _msaaSamples: 1,
        });
        const layouts = pipelineLayouts(compiled._pipelineForMesh(mesh._gpu));
        const color = getNodeAttributeBuffer(f.engine, mesh._gpu, "color");
        const tangent = getNodeAttributeBuffer(f.engine, mesh._gpu, "tangent");
        expect(layouts[0]!.arrayStride).toBe(16);
        expect(layouts[1]!.arrayStride).toBe(0);
        expect(color).toBe(tangent);
        expect(color.size).toBe(16);
    });
});
