import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import type { MaterialPlugin } from "../../../packages/babylon-lite/src/material/plugin/material-plugin";
import { enableMaterialPlugins } from "../../../packages/babylon-lite/src/material/plugin/enable-material-plugins";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { clearPbrPipelineCache } from "../../../packages/babylon-lite/src/material/pbr/pbr-pipeline";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable";
import type { ToneMapping } from "../../../packages/babylon-lite/src/material/pbr/tone-mapping";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";

function makeEngine(): { engine: EngineContext; createShaderModule: ReturnType<typeof vi.fn> } {
    const createShaderModule = vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule);
    const device = {
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule,
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup),
        createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => descriptor as unknown as GPUSampler),
        createTexture: vi.fn(
            () =>
                ({
                    createView: vi.fn(() => ({}) as GPUTextureView),
                    destroy: vi.fn(),
                }) as unknown as GPUTexture
        ),
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
        receiveShadows: false,
        morphTargets: null,
        worldMatrix,
        worldMatrixVersion: 1,
        _gpu: {},
    } as unknown as Mesh;
}

const signature = {
    _colorFormat: "rgba8unorm",
    _depthStencilFormat: "depth24plus",
    _sampleCount: 1,
} as RenderTargetSignature;

function fragmentSources(createShaderModule: ReturnType<typeof vi.fn>): string[] {
    return createShaderModule.mock.calls.map((call) => (call[0] as GPUShaderModuleDescriptor).code).filter((code) => code.includes("@fragment fn main"));
}

describe("PBR shader variant caches", () => {
    beforeEach(() => {
        clearPbrPipelineCache();
        clearSceneBGLCache();
    });

    it("separates tone-mapping algorithms that share all feature flags", async () => {
        const { engine, createShaderModule } = makeEngine();
        const makeToneMapping = (id: string): ToneMapping => ({
            id,
            helpersWGSL: "",
            callWGSL: `color*=scene.vImageInfos.x;\ncolor+=vec3f(0.0); // ${id}`,
        });
        const pipelines: GPURenderPipeline[] = [];

        for (const id of ["tone-a", "tone-b"]) {
            const scene = createSceneContext(engine, { defaultRenderTask: false });
            scene.imageProcessing.toneMappingEnabled = true;
            scene.imageProcessing.toneMapping = makeToneMapping(id);
            const material = createPbrMaterial();
            const mesh = makeMesh(material);
            scene._groups.set(material._buildGroup, [mesh]);
            const result = await buildPbrRenderables(scene, [mesh], undefined);
            pipelines.push(result.renderables[0]!.bind(engine, signature).pipeline);
        }

        expect(pipelines[0]).not.toBe(pipelines[1]);
        const fragments = fragmentSources(createShaderModule);
        expect(fragments.some((code) => code.includes("// tone-a"))).toBe(true);
        expect(fragments.some((code) => code.includes("// tone-b"))).toBe(true);
    });

    it("separates material-plugin variants without consuming native feature bits", async () => {
        const { engine, createShaderModule } = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const plugin = (name: string, marker: string): MaterialPlugin => ({
            name,
            getCustomCode: (shaderType) => (shaderType === "fragment" ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: marker } : null),
        });
        const materialA = createPbrMaterial({ plugins: [plugin("plugin-a", "if(material.materialAlpha < -1.0){discard;}")] });
        const materialB = createPbrMaterial({ plugins: [plugin("plugin-b", "if(material.materialAlpha < -2.0){discard;}")] });
        const meshes = [makeMesh(materialA), makeMesh(materialB)];
        scene._groups.set(materialA._buildGroup, meshes);
        enableMaterialPlugins(scene);

        const result = await buildPbrRenderables(scene, meshes, undefined);
        const pipelineA = result.renderables[0]!.bind(engine, signature).pipeline;
        const pipelineB = result.renderables[1]!.bind(engine, signature).pipeline;

        expect(materialA._renderFeatures?.features2).toBe(materialB._renderFeatures?.features2);
        expect(materialA._pi).not.toBe(materialB._pi);
        expect(pipelineA).not.toBe(pipelineB);
        const fragments = fragmentSources(createShaderModule);
        expect(fragments.some((code) => code.includes("material.materialAlpha < -1.0"))).toBe(true);
        expect(fragments.some((code) => code.includes("material.materialAlpha < -2.0"))).toBe(true);
    });

    it("normalizes a missing material-plugin index to zero", async () => {
        const { engine } = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const materialWithoutIndex = createPbrMaterial();
        const materialWithZeroIndex = createPbrMaterial();
        materialWithZeroIndex._pi = 0;
        const meshes = [makeMesh(materialWithoutIndex), makeMesh(materialWithZeroIndex)];
        scene._groups.set(materialWithoutIndex._buildGroup, meshes);

        const result = await buildPbrRenderables(scene, meshes, undefined);
        const pipelineWithoutIndex = result.renderables[0]!.bind(engine, signature).pipeline;
        const pipelineWithZeroIndex = result.renderables[1]!.bind(engine, signature).pipeline;

        expect(pipelineWithZeroIndex).toBe(pipelineWithoutIndex);
    });
});
