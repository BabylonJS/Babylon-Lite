import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentTextures } from "../../../packages/babylon-lite/src/loader-env/load-env.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene.js";

const mocks = vi.hoisted(() => ({
    parseRGBE: vi.fn(() => ({ width: 1, height: 1, data: new Float32Array(3) })),
    computeSHFromEquirect: vi.fn(() => new Float32Array(27)),
    equirectToCubemapGPU: vi.fn(() => ({ label: "source" }) as unknown as GPUTexture),
    prefilterCubemapGPU: vi.fn(() => ({ label: "specular" }) as unknown as GPUTexture),
    generateBrdfLut: vi.fn(() => ({ label: "brdf" }) as unknown as GPUTexture),
    assembleEnvironmentTextures: vi.fn(
        (specularCube: GPUTexture, brdfLut: GPUTexture, irradianceSH: Float32Array, lodGenerationScale: number) =>
            ({ specularCube, brdfLut, irradianceSH, lodGenerationScale }) as EnvironmentTextures
    ),
    acquireGPUTexture: vi.fn(),
    releaseGPUTexture: vi.fn(),
    registerEnvSceneUniforms: vi.fn(),
}));

vi.mock("../../../packages/babylon-lite/src/loader-hdr/hdr-parser.js", () => ({
    parseRGBE: mocks.parseRGBE,
    computeSHFromEquirect: mocks.computeSHFromEquirect,
}));

vi.mock("../../../packages/babylon-lite/src/loader-hdr/hdr-ibl-pipeline.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../packages/babylon-lite/src/loader-hdr/hdr-ibl-pipeline.js")>()),
    equirectToCubemapGPU: mocks.equirectToCubemapGPU,
    prefilterCubemapGPU: mocks.prefilterCubemapGPU,
    generateBrdfLut: mocks.generateBrdfLut,
}));

vi.mock("../../../packages/babylon-lite/src/loader-env/env-helpers.js", () => ({
    assembleEnvironmentTextures: mocks.assembleEnvironmentTextures,
}));

vi.mock("../../../packages/babylon-lite/src/resource/gpu-pool.js", () => ({
    acquireGPUTexture: mocks.acquireGPUTexture,
    releaseGPUTexture: mocks.releaseGPUTexture,
}));

vi.mock("../../../packages/babylon-lite/src/scene/scene-ubo-extras.js", () => ({
    registerEnvSceneUniforms: mocks.registerEnvSceneUniforms,
}));

import { HDR_LOD_GENERATION_SCALE } from "../../../packages/babylon-lite/src/loader-hdr/hdr-ibl-pipeline.js";
import { loadHdrEnvironment } from "../../../packages/babylon-lite/src/loader-hdr/load-hdr.js";

function makeScene(): SceneContext {
    return {
        surface: { engine: {} },
        _disposables: [],
        _deferredBuilders: [],
        _renderables: [],
        imageProcessing: {},
    } as unknown as SceneContext;
}

describe("loadHdrEnvironment", () => {
    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it("rejects an HTTP failure before consuming or parsing the response body", async () => {
        const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, arrayBuffer })) as unknown as typeof fetch);

        await expect(loadHdrEnvironment(makeScene(), "https://cdn.example.com/studio.hdr")).rejects.toThrow("HDR 503: https://cdn.example.com/studio.hdr");
        expect(arrayBuffer).not.toHaveBeenCalled();
        expect(mocks.parseRGBE).not.toHaveBeenCalled();
    });

    it("assembles HDR textures with Babylon.js' LOD generation scale", async () => {
        const buffer = new ArrayBuffer(4);
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => buffer })) as unknown as typeof fetch);
        const scene = makeScene();

        await loadHdrEnvironment(scene, "/studio.hdr");

        expect(HDR_LOD_GENERATION_SCALE).toBe(0.8);
        expect(mocks.assembleEnvironmentTextures).toHaveBeenCalledWith(
            mocks.prefilterCubemapGPU.mock.results[0]!.value,
            mocks.generateBrdfLut.mock.results[0]!.value,
            mocks.computeSHFromEquirect.mock.results[0]!.value,
            HDR_LOD_GENERATION_SCALE,
            scene.surface.engine
        );
    });
});
