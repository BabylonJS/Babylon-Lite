import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createLineMaterial } from "../../../packages/babylon-lite/src/material/line/line-material";
import { createShaderMaterial, setShaderTexture } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { initMeshTransform, type Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { MeshRebuildResources } from "../../../packages/babylon-lite/src/render/renderable";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

function createFixture(failBindGroup = false): {
    engine: EngineContext;
    scene: SceneContext;
    mesh: Mesh;
    resources: MeshRebuildResources;
    destroy: ReturnType<typeof vi.fn>;
    failNextBindGroup: () => void;
} {
    const destroy = vi.fn();
    let fail = failBindGroup;
    const device = {
        createBuffer: vi.fn(() => ({ destroy }) as unknown as GPUBuffer),
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => {
            if (fail) {
                fail = false;
                throw new Error("bind group failed");
            }
            return descriptor as unknown as GPUBindGroup;
        }),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
        queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    const engine = { _device: device, canvas: { width: 1, height: 1 } } as unknown as EngineContext;
    const material = createShaderMaterial({
        vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
        fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
        attributes: ["position"],
    });
    const mesh = initMeshTransform({
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
    return {
        engine,
        scene,
        mesh,
        resources: { _lifetimeDisposers: [] },
        destroy,
        failNextBindGroup: () => {
            fail = true;
        },
    };
}

function texture(): Texture2D & { texture: GPUTexture & { destroy: ReturnType<typeof vi.fn> } } {
    return {
        texture: { destroy: vi.fn() } as unknown as GPUTexture & { destroy: ReturnType<typeof vi.fn> },
        view: {} as GPUTextureView,
        sampler: {} as GPUSampler,
        width: 1,
        height: 1,
    };
}

describe("ShaderMaterial auxiliary ownership", () => {
    it("destroys an unpublished system buffer when its initial upload fails", () => {
        const { engine, scene, mesh, resources, destroy } = createFixture();
        vi.mocked(engine._device.queue.writeBuffer).mockImplementationOnce(() => {
            throw new Error("initial shader upload failed");
        });
        expect(() => buildShaderMaterialRenderables(scene, []).rebuildSingle(scene, mesh, mesh.material, resources)).toThrow("initial shader upload failed");
        expect(destroy).toHaveBeenCalledOnce();
        expect(resources._lifetimeDisposers).toHaveLength(0);
        expect(scene._meshDisposables.size).toBe(0);
    });

    it("puts an explicit rebuild packet only in the supplied lifetime sink", () => {
        const { scene, mesh, resources, destroy } = createFixture();

        buildShaderMaterialRenderables(scene, []).rebuildSingle(scene, mesh, mesh.material, resources);

        expect(resources._lifetimeDisposers).toHaveLength(1);
        expect(scene._meshDisposables.size).toBe(0);

        resources._lifetimeDisposers[0]!();
        expect(destroy).toHaveBeenCalledOnce();
    });

    it("uses scene ownership without an explicit sink, independently of override identity", () => {
        const { scene, mesh, resources, destroy } = createFixture();

        buildShaderMaterialRenderables(scene, []).rebuildSingle(scene, mesh, mesh.material);

        const sceneOwned = scene._meshDisposables.get(mesh)!;
        expect(sceneOwned).toHaveLength(1);
        expect(resources._lifetimeDisposers).toHaveLength(0);
        sceneOwned[0]!();
        expect(destroy).toHaveBeenCalledOnce();
    });

    it("registers packet cleanup before a later bind-group failure", () => {
        const { scene, mesh, resources, destroy } = createFixture(true);

        expect(() => buildShaderMaterialRenderables(scene, []).rebuildSingle(scene, mesh, mesh.material, resources)).toThrow("bind group failed");
        expect(resources._lifetimeDisposers).toHaveLength(1);
        expect(scene._meshDisposables.size).toBe(0);

        resources._lifetimeDisposers[0]!();
        expect(destroy).toHaveBeenCalledOnce();
    });

    it("receives explicit ownership through the LineMaterial rebuild wrapper", async () => {
        const { scene, mesh, destroy } = createFixture();
        const material = createLineMaterial({ useVertexAlpha: false });
        mesh.material = material;
        const result = await material._buildGroup(scene, [mesh]);
        const sceneOwned = scene._meshDisposables.get(mesh);
        const resources: MeshRebuildResources = { _lifetimeDisposers: [] };

        result.rebuildSingle(scene, mesh, material, resources);

        expect(resources._lifetimeDisposers).toHaveLength(1);
        expect(scene._meshDisposables.get(mesh)).toBe(sceneOwned);

        resources._lifetimeDisposers[0]!();
        expect(destroy).toHaveBeenCalledOnce();
    });

    it("keeps the old texture packet intact when a resource rebake fails", () => {
        const { engine, scene, mesh, resources, failNextBindGroup } = createFixture();
        const material = createShaderMaterial({
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
            attributes: ["position"],
            samplers: [{ name: "color" }],
        });
        mesh.material = material;
        const oldTexture = texture();
        const newTexture = texture();
        setShaderTexture(material, "color", oldTexture);
        const renderable = buildShaderMaterialRenderables(scene, []).rebuildSingle(scene, mesh, material, resources);
        const binding = renderable.bind(engine, { _colorFormat: "rgba8unorm", _sampleCount: 1 } as never);

        setShaderTexture(material, "color", newTexture);
        failNextBindGroup();

        expect(() => binding.update!({ targetWidth: 1, targetHeight: 1 })).toThrow("bind group failed");
        expect(oldTexture.texture.destroy).not.toHaveBeenCalled();
        expect(newTexture.texture.destroy).not.toHaveBeenCalled();

        resources._lifetimeDisposers[0]!();
        expect(oldTexture.texture.destroy).toHaveBeenCalledOnce();
        expect(newTexture.texture.destroy).not.toHaveBeenCalled();
    });

    it("rebuilds a binding when the same texture facade exposes a replacement view", () => {
        const { engine, scene, mesh, resources } = createFixture();
        const material = createShaderMaterial({
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
            attributes: ["position"],
            samplers: [{ name: "color" }],
        });
        mesh.material = material;
        const facade = texture();
        setShaderTexture(material, "color", facade);
        const renderable = buildShaderMaterialRenderables(scene, []).rebuildSingle(scene, mesh, material, resources);
        const binding = renderable.bind(engine, { _colorFormat: "rgba8unorm", _sampleCount: 1 } as never);
        const createBindGroup = vi.mocked(engine._device.createBindGroup);
        const initialCalls = createBindGroup.mock.calls.length;
        const version = material._resourceVersion;

        setShaderTexture(material, "color", facade);
        expect(material._resourceVersion).toBe(version);

        const replacementView = {} as GPUTextureView;
        facade.view = replacementView;
        setShaderTexture(material, "color", facade);
        expect(material._resourceVersion).toBe(version + 1);
        binding.update!({ targetWidth: 1, targetHeight: 1 });

        expect(createBindGroup).toHaveBeenCalledTimes(initialCalls + 1);
        const descriptor = createBindGroup.mock.calls.at(-1)![0];
        expect(descriptor.entries.some((entry) => entry.resource === replacementView)).toBe(true);
        resources._lifetimeDisposers[0]!();
    });
});
