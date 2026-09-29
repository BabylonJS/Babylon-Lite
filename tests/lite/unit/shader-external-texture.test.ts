import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { createShaderMaterial, getShaderExternalTexture, setShaderExternalTexture, setShaderTexture } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { initMeshTransform, type Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { _textureOwners } from "../../../packages/babylon-lite/src/resource/gpu-pool";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";
import { createExternalTexture, isExternalTextureReady } from "../../../packages/babylon-lite/src/texture/external-texture";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

function createVideo(readyState = 2): HTMLVideoElement {
    return {
        HAVE_CURRENT_DATA: 2,
        readyState,
    } as HTMLVideoElement;
}

function createTexture(): Texture2D {
    return {
        texture: { destroy: vi.fn() } as unknown as GPUTexture,
        view: {} as GPUTextureView,
        sampler: {} as GPUSampler,
        width: 1,
        height: 1,
    };
}

function createFixture(): {
    engine: EngineContext;
    scene: SceneContext;
    mesh: Mesh;
    importExternalTexture: ReturnType<typeof vi.fn>;
    createBindGroupLayout: ReturnType<typeof vi.fn>;
    createBindGroup: ReturnType<typeof vi.fn>;
    createShaderModule: ReturnType<typeof vi.fn>;
} {
    const importExternalTexture = vi.fn((descriptor: GPUExternalTextureDescriptor) => descriptor as unknown as GPUExternalTexture);
    const createBindGroupLayout = vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout);
    const createBindGroup = vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup);
    const createShaderModule = vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule);
    const createSampler = vi.fn((descriptor: GPUSamplerDescriptor) => descriptor as unknown as GPUSampler);
    const device = {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({ size: descriptor.size, destroy: vi.fn() }) as unknown as GPUBuffer),
        createBindGroupLayout,
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createBindGroup,
        createShaderModule,
        createSampler,
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
        importExternalTexture,
        queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    const engine = {
        _device: device,
        canvas: { width: 64, height: 64 },
    } as unknown as EngineContext;
    const material = createShaderMaterial({
        vertexSource: wgsl`struct VertexOutput { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = shaderSystem.worldViewProjection * vec4f(input.position, 1);
    out.uv = input.uv;
    return out;
}`,
        fragmentSource: wgsl`struct VertexOutput { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4f {
    return textureSample(textureSampler, textureSamplerSampler, input.uv) * textureSampleBaseClampToEdge(videoSampler, videoSamplerSampler, input.uv);
}`,
        attributes: ["position", "uv"],
        uniforms: ["worldViewProjection"],
        samplers: ["textureSampler"],
        externalTextures: ["videoSampler"],
    });
    const mesh = initMeshTransform({
        name: "external-texture",
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
    return { engine, scene, mesh, importExternalTexture, createBindGroupLayout, createBindGroup, createShaderModule };
}

describe("ShaderMaterial external textures", () => {
    it("validates declarations and preserves wrapper identity", () => {
        const material = createShaderMaterial({
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
            attributes: ["position"],
            externalTextures: ["videoSampler"],
        });
        const video = createVideo();
        const texture = createExternalTexture(video);

        expect(texture.video).toBe(video);
        expect(isExternalTextureReady(texture)).toBe(true);
        expect(isExternalTextureReady(createExternalTexture(createVideo(1)))).toBe(false);
        expect(getShaderExternalTexture(material, "videoSampler")).toBeNull();

        setShaderExternalTexture(material, "videoSampler", texture);
        expect(getShaderExternalTexture(material, "videoSampler")).toBe(texture);
        expect(() => setShaderExternalTexture(material, "missing", texture)).toThrow('external texture "missing" was not declared');
        expect(() =>
            createShaderMaterial({
                vertexSource: material.vertexSource,
                fragmentSource: material.fragmentSource,
                attributes: ["position"],
                samplers: ["videoSampler"],
                externalTextures: ["videoSampler"],
            })
        ).toThrow('duplicate generated identifier "videoSampler"');
    });

    it("emits texture_external bindings and imports a fresh frame without texture lease churn", () => {
        const { engine, scene, mesh, importExternalTexture, createBindGroupLayout, createBindGroup, createShaderModule } = createFixture();
        const material = mesh.material as ReturnType<typeof createShaderMaterial>;
        const texture = createTexture();
        const firstVideo = createVideo();
        setShaderTexture(material, "textureSampler", texture);
        setShaderExternalTexture(material, "videoSampler", createExternalTexture(firstVideo));

        const built = buildShaderMaterialRenderables(scene, [mesh]);
        const renderable = built.renderables[0]!;
        expect(renderable._direct).toBe(true);
        expect(importExternalTexture).toHaveBeenCalledOnce();
        expect(_textureOwners(texture)).toBe(1);

        const binding = renderable.bind(engine, { _colorFormat: "rgba8unorm", _sampleCount: 1 } as RenderTargetSignature);
        const materialLayout = createBindGroupLayout.mock.calls.map((call) => call[0]).find((descriptor) => descriptor.label === "shader-material-group1")!;
        expect(materialLayout.entries).toEqual([
            { binding: 0, visibility: 3, buffer: { type: "uniform" } },
            { binding: 1, visibility: 3, texture: { sampleType: "float", viewDimension: "2d" } },
            { binding: 2, visibility: 3, sampler: { type: "filtering" } },
            { binding: 3, visibility: 3, externalTexture: {} },
            { binding: 4, visibility: 3, sampler: { type: "filtering" } },
        ]);
        expect(
            createShaderModule.mock.calls.some((call) =>
                String(call[0].code).includes("@group(1) @binding(3) var videoSampler: texture_external;\n@group(1) @binding(4) var videoSamplerSampler: sampler;")
            )
        ).toBe(true);

        binding.update!({ targetWidth: 64, targetHeight: 64 });
        binding.update!({ targetWidth: 64, targetHeight: 64 });
        expect(importExternalTexture).toHaveBeenCalledTimes(3);
        expect(createBindGroup).toHaveBeenCalledTimes(3);
        expect(_textureOwners(texture)).toBe(1);

        const secondVideo = createVideo();
        setShaderExternalTexture(material, "videoSampler", createExternalTexture(secondVideo));
        binding.update!({ targetWidth: 64, targetHeight: 64 });
        expect(importExternalTexture).toHaveBeenLastCalledWith({ source: secondVideo });
        expect(_textureOwners(texture)).toBe(1);

        for (const dispose of scene._meshDisposables.get(mesh) ?? []) {
            dispose();
        }
        expect(_textureOwners(texture)).toBe(0);
    });

    it("rejects a video without current frame data before importing it", () => {
        const { scene, mesh, importExternalTexture } = createFixture();
        const material = mesh.material as ReturnType<typeof createShaderMaterial>;
        setShaderTexture(material, "textureSampler", createTexture());
        setShaderExternalTexture(material, "videoSampler", createExternalTexture(createVideo(1)));

        expect(() => buildShaderMaterialRenderables(scene, [mesh])).toThrow('external texture "videoSampler" is not ready');
        expect(importExternalTexture).not.toHaveBeenCalled();
    });
});
