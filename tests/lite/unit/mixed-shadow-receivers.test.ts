import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { DrawBinding } from "../../../packages/babylon-lite/src/render/renderable";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import { createDirectionalLight } from "../../../packages/babylon-lite/src/light/directional-light";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";
import { setCsmPbrReceiverFactory, setCsmStdReceiverFactory } from "../../../packages/babylon-lite/src/shadow/csm-receiver-registry";
import { createStdCsmShadowFragment } from "../../../packages/babylon-lite/src/material/standard/fragments/std-csm-shadow-fragment";
import { createPbrCsmShadowFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/pbr-csm-shadow-fragment";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import { createStandardShadowContext } from "../../../packages/babylon-lite/src/material/standard/fragments/std-shadow-fragment";
import { buildStandardMeshRenderables } from "../../../packages/babylon-lite/src/material/standard/standard-renderable";
import { clearStandardPipelineCache } from "../../../packages/babylon-lite/src/material/standard/standard-pipeline";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable";
import { clearPbrPipelineCache } from "../../../packages/babylon-lite/src/material/pbr/pbr-pipeline";

const signature: RenderTargetSignature = { _colorFormat: "bgra8unorm", _depthStencilFormat: "depth24plus-stencil8", _sampleCount: 1 };

function createEngine(): EngineContext {
    const device = {
        createBindGroupLayout: vi.fn((descriptor) => descriptor),
        createPipelineLayout: vi.fn((descriptor) => descriptor),
        createBindGroup: vi.fn((descriptor) => descriptor),
        createShaderModule: vi.fn((descriptor) => descriptor),
        createRenderPipeline: vi.fn((descriptor) => descriptor),
        createSampler: vi.fn((descriptor) => descriptor),
        createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({ size: descriptor.size, destroy: vi.fn() })),
        queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
        limits: { maxTextureDimension2D: 8192 },
    } as unknown as GPUDevice;
    const engine = { _device: device, _disposables: [], canvas: { width: 64, height: 64 }, format: "bgra8unorm", msaaSamples: 1 } as unknown as EngineContext;
    return Object.assign(engine, { engine });
}

function createScene(engine: EngineContext, shadowTypes: readonly ShadowGenerator["_shadowType"][]) {
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.camera = createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 });
    for (const shadowType of shadowTypes) {
        const light = createDirectionalLight([0, -1, 0]);
        light.shadowGenerator = { _shadowType: shadowType, _depthTexture: { createView: () => ({}) }, _depthSampler: {}, _shadowUBO: {} } as unknown as ShadowGenerator;
        scene.lights.push(light);
    }
    return scene;
}

function createMesh(material: Mesh["material"]): Mesh {
    return Object.assign(createTransformNode("receiver"), {
        material,
        visible: true,
        receiveShadows: true,
        _gpu: { positionBuffer: {}, normalBuffer: {}, uvBuffer: {}, indexBuffer: {}, indexCount: 3, indexFormat: "uint16" },
    }) as Mesh;
}

async function buildReceiver(family: "standard" | "pbr", engine: EngineContext, shadowTypes: readonly ShadowGenerator["_shadowType"][]): Promise<DrawBinding> {
    const scene = createScene(engine, shadowTypes);
    if (family === "standard") {
        const mesh = createMesh(createStandardMaterial());
        return buildStandardMeshRenderables(scene, [mesh], { shadow: await createStandardShadowContext(engine, scene.lights) }).renderables[0]!.bind(engine, signature);
    }
    const material = createPbrMaterial({});
    const mesh = createMesh(material);
    scene._groups.set(material._buildGroup, [mesh]);
    return (await buildPbrRenderables(scene, [mesh], undefined)).renderables[0]!.bind(engine, signature);
}

/** The group-2 layout the pipeline was built with, and the group-2 bind group the draw sets. */
function shadowGroup(binding: DrawBinding, engine: EngineContext) {
    const pass = { setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), setBindGroup: vi.fn(), drawIndexed: vi.fn(), drawIndexedIndirect: vi.fn() };
    binding.draw(pass as unknown as GPURenderPassEncoder, engine);
    const pipeline = binding.pipeline as unknown as GPURenderPipelineDescriptor;
    const layout = (pipeline.layout as unknown as GPUPipelineLayoutDescriptor).bindGroupLayouts[2] as unknown as GPUBindGroupLayoutDescriptor;
    const group = pass.setBindGroup.mock.calls.find(([index]) => index === 2)![1] as unknown as GPUBindGroupDescriptor;
    return { layout: [...layout.entries], group: [...group.entries], code: (pipeline.fragment!.module as unknown as GPUShaderModuleDescriptor).code.replace(/\s+/g, "") };
}

beforeEach(() => {
    clearStandardPipelineCache();
    clearPbrPipelineCache();
    clearSceneBGLCache();
    setCsmStdReceiverFactory(createStdCsmShadowFragment);
    setCsmPbrReceiverFactory(createPbrCsmShadowFragment);
});

describe("mixed CSM + ESM/PCF shadow receivers", () => {
    it.each(["standard", "pbr"] as const)("declares every %s shadow light in light-slot order", async (family) => {
        const engine = createEngine();
        const { layout, group, code } = shadowGroup(await buildReceiver(family, engine, ["esm", "csm", "pcf"]), engine);

        const declarations = [...code.matchAll(/@group\(2\)@binding\((\d+)\)var(?:<uniform>)?(\w+):([\w<>]+);/g)].map(([, index, name, type]) => [Number(index), name, type]);
        expect(declarations.map(([index, name]) => [index, name])).toEqual([
            [0, "shadowTex_0"],
            [1, "shadowSamp_0"],
            [2, "shadowInfo_0"],
            [3, "csmTex_1"],
            [4, "csmComp_1"],
            [5, "csmInfo_1"],
            [6, "shadowTex_2"],
            [7, "shadowComp_2"],
            [8, "shadowInfo_2"],
        ]);
        expect(declarations.filter(([index]) => index !== 2 && index !== 5 && index !== 8).map(([, , type]) => type)).toEqual([
            "texture_2d<f32>",
            "sampler",
            "texture_depth_2d_array",
            "sampler_comparison",
            "texture_depth_2d",
            "sampler_comparison",
        ]);
        expect(layout.map((entry) => entry.binding)).toEqual(group.map((entry) => entry.binding));
        expect(layout).toHaveLength(9);
        expect(code).toContain("shadowFactors[0]=computeShadowESM_0(");
        expect(code).toContain("shadowFactors[1]=computeShadowCSM_1(");
        expect(code).toContain("shadowFactors[2]=computeShadowPCF_2(");
    });

    it("keeps PBR group-2 layouts apart for scenes with different shadow slots on one device", async () => {
        const engine = createEngine();
        const pcfOnly = shadowGroup(await buildReceiver("pbr", engine, ["pcf"]), engine);
        const mixed = shadowGroup(await buildReceiver("pbr", engine, ["csm", "pcf"]), engine);

        expect(pcfOnly.layout).toHaveLength(3);
        expect(pcfOnly.group).toHaveLength(3);
        expect(mixed.layout).toHaveLength(6);
        expect(mixed.group).toHaveLength(6);
        expect(mixed.code).toContain("shadowFactors[0]=computeShadowCSM_0(");
    });
});
