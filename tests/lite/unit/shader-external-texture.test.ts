import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import type { MaterialView } from "../../../packages/babylon-lite/src/material/material";
import { getShaderExternalTexture, setShaderExternalTexture } from "../../../packages/babylon-lite/src/material/shader/shader-external-texture";
import { createShaderMaterial, setShaderTexture, type ShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { createShaderNoColorMaterialView } from "../../../packages/babylon-lite/src/material/shader/no-color-view";
import { getOrCreateShaderPipelineBindings } from "../../../packages/babylon-lite/src/material/shader/shader-pipeline";
import { buildShaderGroup, buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { initMeshTransform, type Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { setThinInstances } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import * as gpuPool from "../../../packages/babylon-lite/src/resource/gpu-pool";
import * as textureAcquire from "../../../packages/babylon-lite/src/resource/texture-acquire";
import * as textureRelease from "../../../packages/babylon-lite/src/resource/texture-release";
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
    createSampler: ReturnType<typeof vi.fn>;
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
    return { engine, scene, mesh, importExternalTexture, createBindGroupLayout, createBindGroup, createShaderModule, createSampler };
}

describe("ShaderMaterial external textures", () => {
    afterEach(() => vi.restoreAllMocks());

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
        const duplicate = createShaderMaterial({
            vertexSource: material.vertexSource,
            fragmentSource: material.fragmentSource,
            attributes: ["position"],
            samplers: ["videoSampler"],
            externalTextures: ["videoSampler"],
        });
        expect(() => getShaderExternalTexture(duplicate, "videoSampler")).toThrow('duplicate generated identifier "videoSampler"');
    });

    it.each([false, true])("imports and draws fresh external frames without lease churn (thin instances: %s)", async (instanced) => {
        const acquireTexture = vi.spyOn(textureAcquire, "acquireTexture");
        const releaseTexture = vi.spyOn(textureRelease, "releaseTexture");
        const { engine, scene, mesh, importExternalTexture, createBindGroupLayout, createBindGroup, createShaderModule, createSampler } = createFixture();
        const material = mesh.material as ReturnType<typeof createShaderMaterial>;
        const texture = createTexture();
        const firstVideo = createVideo();
        setShaderTexture(material, "textureSampler", texture);
        setShaderExternalTexture(material, "videoSampler", createExternalTexture(firstVideo));
        if (instanced) {
            setThinInstances(mesh, new Float32Array(mesh.worldMatrix), 1);
        }

        const built = await buildShaderGroup(scene, [mesh]);
        const renderable = built.renderables[0]!;
        expect(renderable._direct).toBe(true);
        expect(importExternalTexture).toHaveBeenCalledOnce();
        expect(gpuPool._textureOwners(texture)).toBe(1);

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

        const pass = { setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), setBindGroup: vi.fn(), drawIndexed: vi.fn() };
        binding.update!({ targetWidth: 64, targetHeight: 64 });
        binding.draw(pass as unknown as GPURenderPassEncoder, engine);
        const firstFrameGroup = pass.setBindGroup.mock.calls.at(-1)![1] as GPUBindGroupDescriptor;
        binding.update!({ targetWidth: 64, targetHeight: 64 });
        binding.draw(pass as unknown as GPURenderPassEncoder, engine);
        const secondFrameGroup = pass.setBindGroup.mock.calls.at(-1)![1] as GPUBindGroupDescriptor;
        expect(secondFrameGroup).not.toBe(firstFrameGroup);
        expect(pass.drawIndexed).toHaveBeenCalledTimes(2);
        expect(Array.from(secondFrameGroup.entries)[3]!.resource).toEqual({ source: firstVideo });
        expect(importExternalTexture).toHaveBeenCalledTimes(3);
        expect(createBindGroup).toHaveBeenCalledTimes(3);
        expect(createSampler).toHaveBeenCalledOnce();
        expect(gpuPool._textureOwners(texture)).toBe(1);
        expect(acquireTexture).toHaveBeenCalledOnce();
        expect(releaseTexture).not.toHaveBeenCalled();

        const secondVideo = createVideo();
        setShaderExternalTexture(material, "videoSampler", createExternalTexture(secondVideo));
        binding.update!({ targetWidth: 64, targetHeight: 64 });
        binding.draw(pass as unknown as GPURenderPassEncoder, engine);
        expect(importExternalTexture).toHaveBeenLastCalledWith({ source: secondVideo });
        const replacedFrameGroup = pass.setBindGroup.mock.calls.at(-1)![1] as GPUBindGroupDescriptor;
        expect(Array.from(replacedFrameGroup.entries)[3]!.resource).toEqual({ source: secondVideo });
        expect(gpuPool._textureOwners(texture)).toBe(1);

        for (const dispose of scene._meshDisposables.get(mesh) ?? []) {
            dispose();
        }
        expect(gpuPool._textureOwners(texture)).toBe(0);
    });

    it("hydrates view-first declarations on the source and shares subsequent bindings", () => {
        const { mesh: enabledMesh } = createFixture();
        getShaderExternalTexture(enabledMesh.material as ReturnType<typeof createShaderMaterial>, "videoSampler");
        const { engine, scene, mesh, importExternalTexture } = createFixture();
        const material = mesh.material as ReturnType<typeof createShaderMaterial>;
        const view = createShaderNoColorMaterialView(material) as MaterialView & ShaderMaterial;
        getOrCreateShaderPipelineBindings(engine, view);
        expect(Object.hasOwn(view, "_externalTextureSlots")).toBe(false);
        expect(Object.hasOwn(material, "_externalTextureSlots")).toBe(true);
        const texture = createExternalTexture(createVideo());
        setShaderTexture(material, "textureSampler", createTexture());
        setShaderExternalTexture(material, "videoSampler", texture);
        expect(getShaderExternalTexture(view, "videoSampler")).toBe(texture);

        mesh.material = view;
        const renderable = buildShaderMaterialRenderables(scene, [mesh]).renderables[0]!;
        expect(renderable._direct).toBe(true);
        const binding = renderable.bind(engine, { _colorFormat: "rgba8unorm", _sampleCount: 1 });
        const nextTexture = createExternalTexture(createVideo());
        const version = material._resourceVersion;
        setShaderExternalTexture(view, "videoSampler", nextTexture);
        expect(material._resourceVersion).toBe(version + 1);
        expect(Object.hasOwn(view, "_resourceVersion")).toBe(false);
        expect(getShaderExternalTexture(material, "videoSampler")).toBe(nextTexture);
        binding.update!({ targetWidth: 64, targetHeight: 64 });
        expect(importExternalTexture).toHaveBeenLastCalledWith({ source: nextTexture.video });
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
