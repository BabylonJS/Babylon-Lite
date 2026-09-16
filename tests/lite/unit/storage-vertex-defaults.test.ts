import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { createShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { buildShaderGroup, buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { setShaderAttributeFormats } from "../../../packages/babylon-lite/src/material/shader/shader-vb";
import { createMeshFromStorageBuffer } from "../../../packages/babylon-lite/src/mesh/mesh-from-storage";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
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
        expect(pipelineLayouts(present)[4]!.arrayStride).toBe(8);
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
