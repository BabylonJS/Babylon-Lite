import { beforeEach, describe, expect, it, vi } from "vitest";

import { TU } from "../../../packages/babylon-lite/src/engine/gpu-flags.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { EnvironmentTextures } from "../../../packages/babylon-lite/src/loader-env/load-env.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene.js";

const mocks = vi.hoisted(() => ({
    acquireGPUTexture: vi.fn(),
    releaseGPUTexture: vi.fn(),
    registerEnvSceneUniforms: vi.fn(),
    decodeBrdfPng: vi.fn(() => ({ label: "brdf" }) as unknown as GPUTexture),
    loadBrdfImage: vi.fn(async () => ({ close: vi.fn() }) as unknown as ImageBitmap),
    assembleEnvironmentTextures: vi.fn(
        (specularCube: GPUTexture, brdfLut: GPUTexture) =>
            ({
                specularCube,
                brdfLut,
            }) as EnvironmentTextures
    ),
    parseRGBE: vi.fn(() => ({ width: 1, height: 1, data: new Float32Array(3) })),
    computeSHFromEquirect: vi.fn(() => new Float32Array(27)),
    equirectToCubemapGPU: vi.fn(
        () =>
            ({
                createView: vi.fn(() => ({}) as GPUTextureView),
                destroy: vi.fn(),
            }) as unknown as GPUTexture
    ),
    generateBrdfLut: vi.fn(() => ({ label: "brdf" }) as unknown as GPUTexture),
    getBilinearSampler: vi.fn(() => ({}) as GPUSampler),
    createEmptyUniformBuffer: vi.fn(() => ({ destroy: vi.fn() }) as unknown as GPUBuffer),
}));

vi.mock("../../../packages/babylon-lite/src/resource/gpu-pool.js", () => ({
    acquireGPUTexture: mocks.acquireGPUTexture,
    releaseGPUTexture: mocks.releaseGPUTexture,
}));

vi.mock("../../../packages/babylon-lite/src/scene/scene-ubo-extras.js", () => ({
    registerEnvSceneUniforms: mocks.registerEnvSceneUniforms,
}));

vi.mock("../../../packages/babylon-lite/src/loader-env/env-helpers.js", () => ({
    loadBrdfImage: mocks.loadBrdfImage,
    assembleEnvironmentTextures: mocks.assembleEnvironmentTextures,
}));

vi.mock("../../../packages/babylon-lite/src/loader-env/rgbd-decode.js", () => ({
    decodeBrdfPng: mocks.decodeBrdfPng,
}));

vi.mock("../../../packages/babylon-lite/src/loader-hdr/hdr-parser.js", () => ({
    parseRGBE: mocks.parseRGBE,
    computeSHFromEquirect: mocks.computeSHFromEquirect,
}));

vi.mock("../../../packages/babylon-lite/src/loader-hdr/hdr-ibl-pipeline.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../packages/babylon-lite/src/loader-hdr/hdr-ibl-pipeline.js")>()),
    equirectToCubemapGPU: mocks.equirectToCubemapGPU,
    generateBrdfLut: mocks.generateBrdfLut,
}));

vi.mock("../../../packages/babylon-lite/src/resource/samplers.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../packages/babylon-lite/src/resource/samplers.js")>()),
    getBilinearSampler: mocks.getBilinearSampler,
}));

vi.mock("../../../packages/babylon-lite/src/resource/gpu-buffers.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../packages/babylon-lite/src/resource/gpu-buffers.js")>()),
    createEmptyUniformBuffer: mocks.createEmptyUniformBuffer,
}));

function makeDdsBuffer(): ArrayBuffer {
    const buffer = new ArrayBuffer(128 + 6 * 8);
    const header = new Int32Array(buffer, 0, 32);
    header[3] = 1;
    header[4] = 1;
    header[7] = 1;
    return buffer;
}

function makeEngine(descriptors: GPUTextureDescriptor[]): EngineContext {
    const texture = {
        createView: vi.fn(() => ({}) as GPUTextureView),
        destroy: vi.fn(),
    } as unknown as GPUTexture;
    const pipeline = {
        getBindGroupLayout: vi.fn(() => ({}) as GPUBindGroupLayout),
    } as unknown as GPUComputePipeline;
    const device = {
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
            descriptors.push(descriptor);
            return texture;
        }),
        createShaderModule: vi.fn(() => ({}) as GPUShaderModule),
        createComputePipeline: vi.fn(() => pipeline),
        createCommandEncoder: vi.fn(() => ({
            copyTextureToTexture: vi.fn(),
            finish: vi.fn(() => ({}) as GPUCommandBuffer),
        })),
        queue: {
            submit: vi.fn(),
            writeTexture: vi.fn(),
            writeBuffer: vi.fn(),
        },
    } as unknown as GPUDevice;
    return { _device: device } as EngineContext;
}

function makeScene(engine: EngineContext): SceneContext {
    return {
        surface: { engine },
        _disposables: [],
        _deferredBuilders: [],
        _renderables: [],
        imageProcessing: {},
    } as unknown as SceneContext;
}

describe("PBR local cubemap loader ordering", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => makeDdsBuffer() })) as unknown as typeof fetch);
    });

    it("adds COPY_SRC only to DDS and HDR environments loaded after enablement", async () => {
        const dds = await import("../../../packages/babylon-lite/src/loader-env/load-dds-env.js");
        const hdr = await import("../../../packages/babylon-lite/src/loader-hdr/load-hdr.js");
        const localCubemap = await import("../../../packages/babylon-lite/src/material/pbr/enable-pbr-local-cubemap.js");
        const descriptors: GPUTextureDescriptor[] = [];
        const engine = makeEngine(descriptors);
        const scene = makeScene(engine);

        await dds.loadDdsEnvironment(scene, "/before.dds", { brdfUrl: "/brdf.png" });
        await hdr.loadHdrEnvironment(scene, "/before.hdr", { faceSize: 1 });

        expect(Number(descriptors[0]!.usage) & TU.COPY_SRC).toBe(0);
        expect(Number(descriptors[1]!.usage) & TU.COPY_SRC).toBe(0);

        await localCubemap.enablePbrLocalCubemap();
        await dds.loadDdsEnvironment(scene, "/after.dds", { brdfUrl: "/brdf.png" });
        await hdr.loadHdrEnvironment(scene, "/after.hdr", { faceSize: 1 });

        expect(Number(descriptors[2]!.usage) & TU.COPY_SRC).toBe(TU.COPY_SRC);
        expect(Number(descriptors[3]!.usage) & TU.COPY_SRC).toBe(TU.COPY_SRC);
    });
});
