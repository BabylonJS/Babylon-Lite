import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { enableShaderMaterialFinalColor } from "../../../packages/babylon-lite/src/material/shader/enable-shader-material-final-color";
import { createShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { setSubtreeVisible } from "../../../packages/babylon-lite/src/scene/visibility";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";

function createFixture(): {
    engine: EngineContext;
    scene: SceneContext;
    meshes: [Mesh, Mesh];
    drawIndexed: ReturnType<typeof vi.fn>;
} {
    const drawIndexed = vi.fn();
    const device = {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({ size: descriptor.size, destroy: vi.fn() }) as unknown as GPUBuffer),
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
        queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    const engine = {
        _device: device,
        canvas: { width: 64, height: 64 },
    } as unknown as EngineContext;
    const material = createShaderMaterial({
        vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
        fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
        attributes: ["position"],
    });
    const createMesh = (name: string): Mesh =>
        initMeshTransform({
            name,
            children: [],
            material,
            receiveShadows: false,
            _gpu: {
                positionBuffer: {} as GPUBuffer,
                normalBuffer: {} as GPUBuffer,
                uvBuffer: {} as GPUBuffer,
                indexBuffer: {} as GPUBuffer,
                indexCount: 3,
                indexFormat: "uint32",
            },
        });
    const scene = {
        surface: { engine },
        camera: null,
        _meshDisposables: new Map(),
    } as unknown as SceneContext;

    return { engine, scene, meshes: [createMesh("visible"), createMesh("hidden")], drawIndexed };
}

describe("ShaderMaterial visibility", () => {
    it("skips a hidden mesh inside a merged opaque material batch", () => {
        const { engine, scene, meshes, drawIndexed } = createFixture();
        const result = buildShaderMaterialRenderables(scene, meshes);
        const binding = result.renderables[0]!.bind(engine, { _colorFormat: "rgba8unorm", _sampleCount: 1 } as RenderTargetSignature);
        const pass = {
            setVertexBuffer: vi.fn(),
            setIndexBuffer: vi.fn(),
            setBindGroup: vi.fn(),
            drawIndexed,
        } as unknown as GPURenderPassEncoder;

        setSubtreeVisible(meshes[1], false);

        expect(binding.draw(pass, engine)).toBe(1);
        expect(drawIndexed).toHaveBeenCalledTimes(1);
    });

    it("binds white for a missing color attribute buffer", () => {
        const colorData = new ArrayBuffer(32);
        const colorBuffer = {
            size: colorData.byteLength,
            getMappedRange: vi.fn(() => colorData),
            unmap: vi.fn(),
            destroy: vi.fn(),
        } as unknown as GPUBuffer;
        const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) =>
            descriptor.label === "shader-final-color-white" ? colorBuffer : ({ size: descriptor.size, destroy: vi.fn() } as unknown as GPUBuffer)
        );
        const setVertexBuffer = vi.fn();
        const device = {
            createBuffer,
            createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
            createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
            createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup),
            createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
            createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
            queue: { writeBuffer: vi.fn() },
        } as unknown as GPUDevice;
        const engine = { _device: device, canvas: { width: 64, height: 64 } } as unknown as EngineContext;
        const material = createShaderMaterial({
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
            attributes: ["position", "color"],
        });
        enableShaderMaterialFinalColor(material);
        const mesh = initMeshTransform({
            name: "no vertex color",
            children: [],
            material,
            receiveShadows: false,
            _gpu: {
                positionBuffer: { size: 24 } as GPUBuffer,
                normalBuffer: {} as GPUBuffer,
                uvBuffer: {} as GPUBuffer,
                indexBuffer: {} as GPUBuffer,
                indexCount: 3,
                indexFormat: "uint32",
            },
        });
        const scene = { surface: { engine }, camera: null, _meshDisposables: new Map() } as unknown as SceneContext;
        const binding = buildShaderMaterialRenderables(scene, [mesh]).renderables[0]!.bind(engine, { _colorFormat: "rgba8unorm", _sampleCount: 1 } as RenderTargetSignature);
        const pass = {
            setVertexBuffer,
            setIndexBuffer: vi.fn(),
            setBindGroup: vi.fn(),
            drawIndexed: vi.fn(),
        } as unknown as GPURenderPassEncoder;

        binding.draw(pass, engine);

        expect(createBuffer).toHaveBeenCalledWith(expect.objectContaining({ label: "shader-final-color-white", mappedAtCreation: true, size: 32 }));
        expect(Array.from(new Float32Array(colorData))).toEqual(Array(8).fill(1));
        expect(colorBuffer.unmap).toHaveBeenCalledOnce();
        expect(setVertexBuffer).toHaveBeenNthCalledWith(2, 1, colorBuffer);
    });
});
