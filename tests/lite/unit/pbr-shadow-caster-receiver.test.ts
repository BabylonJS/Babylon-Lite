import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target.js";
import { createDirectionalLight } from "../../../packages/babylon-lite/src/light/directional-light.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { createPbrNoColorMaterialView } from "../../../packages/babylon-lite/src/material/pbr/no-color-view.js";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { clearPbrPipelineCache } from "../../../packages/babylon-lite/src/material/pbr/pbr-pipeline.js";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable.js";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers.js";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene.js";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator.js";

function makeEngine(): { engine: EngineContext; createShaderModule: ReturnType<typeof vi.fn> } {
    const createShaderModule = vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule);
    const device = {
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule,
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup),
        createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => descriptor as unknown as GPUSampler),
        createTexture: vi.fn(() => {
            return {
                createView: vi.fn(() => ({}) as GPUTextureView),
                destroy: vi.fn(),
            } as unknown as GPUTexture;
        }),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const storage = new ArrayBuffer(Number(descriptor.size));
            return {
                destroy: vi.fn(),
                getMappedRange: vi.fn(() => storage),
                unmap: vi.fn(),
            } as unknown as GPUBuffer;
        }),
        queue: {
            writeBuffer: vi.fn(),
            writeTexture: vi.fn(),
        },
    } as unknown as GPUDevice;
    const engine = { _device: device, _disposables: [] } as unknown as EngineContext;
    Object.assign(engine, { engine });
    return { engine, createShaderModule };
}

function makeMesh(material: Mesh["material"]): Mesh {
    const worldMatrix = new Float32Array(16);
    worldMatrix[0] = worldMatrix[5] = worldMatrix[10] = worldMatrix[15] = 1;
    return {
        material,
        receiveShadows: true,
        morphTargets: null,
        worldMatrix,
        worldMatrixVersion: 1,
        _gpu: {},
    } as unknown as Mesh;
}

const shadowSignature = {
    _colorFormat: null,
    _depthStencilFormat: "depth32float",
    _sampleCount: 1,
} as RenderTargetSignature;

describe("PBR shadow caster-receiver shader variants", () => {
    it("declares the single-light uniform type used by the no-color shadow pass", async () => {
        clearPbrPipelineCache();
        clearSceneBGLCache();
        const { engine, createShaderModule } = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const light = createDirectionalLight([0, -1, 0]);
        light.shadowGenerator = {
            _shadowType: "pcf",
            _depthTexture: { createView: vi.fn(() => ({}) as GPUTextureView) },
            _depthSampler: {} as GPUSampler,
            _shadowUBO: {} as GPUBuffer,
        } as ShadowGenerator;
        scene.lights.push(light);

        const material = createPbrMaterial();
        const mesh = makeMesh(material);
        scene._groups.set(material._buildGroup, [mesh]);
        const { rebuildSingle } = await buildPbrRenderables(scene, [mesh], undefined);

        const shadowRenderable = rebuildSingle(scene, mesh, createPbrNoColorMaterialView(material));
        shadowRenderable.bind(engine, shadowSignature);

        const fragmentWgsl = createShaderModule.mock.calls
            .map((call) => (call[0] as GPUShaderModuleDescriptor).code)
            .find((code) => code.includes("var<uniform> lights: lightsUniforms"));
        expect(fragmentWgsl).toContain("struct lightsUniforms");
    });
});
