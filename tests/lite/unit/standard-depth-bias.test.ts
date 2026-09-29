import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import type { StandardMaterialProps } from "../../../packages/babylon-lite/src/material/standard/standard-material";
import { composeStandardShader, getOrCreateStandardPipeline, type StandardShaderBindings } from "../../../packages/babylon-lite/src/material/standard/standard-pipeline";
import { enableStandardDepthBias } from "../../../packages/babylon-lite/src/index";

describe("Standard material depth bias", () => {
    it("leaves optional bias fields absent on new materials and accepts legacy structural materials", () => {
        const material = createStandardMaterial();
        expect(material).not.toHaveProperty("depthBias");
        expect(material).not.toHaveProperty("depthBiasSlopeScale");
        const { depthBias: _constant, depthBiasSlopeScale: _slope, ...legacy } = material;
        const structural: StandardMaterialProps = legacy;
        expect(structural).not.toHaveProperty("depthBias");
        expect(structural).not.toHaveProperty("depthBiasSlopeScale");
    });

    it("keeps biased and unbiased pipelines separate when they share shader bindings", () => {
        const createRenderPipeline = vi.fn((descriptor: GPURenderPipelineDescriptor) => ({ descriptor }) as unknown as GPURenderPipeline);
        const device = {
            createBindGroupLayout: vi.fn(() => ({})),
            createPipelineLayout: vi.fn(() => ({})),
            createShaderModule: vi.fn(() => ({})),
            createRenderPipeline,
        } as unknown as GPUDevice;
        const engine = { _device: device } as EngineContext;
        const signature = {
            _colorFormat: "bgra8unorm",
            _depthStencilFormat: "depth24plus",
            _sampleCount: 1,
        } as RenderTargetSignature;
        const bindings: StandardShaderBindings = {
            _features: 0,
            _meshFeatures: 0,
            _sceneFeatures: 0,
            _meshBGL: {} as GPUBindGroupLayout,
            _shadowBGL: null,
            _composed: composeStandardShader(0),
            _pipelines: new Map(),
        };
        const plain = createStandardMaterial();
        const biased = Object.assign(createStandardMaterial(), { depthBias: 2, depthBiasSlopeScale: 1.25 });
        const slopeOnly = Object.assign(createStandardMaterial(), { depthBiasSlopeScale: 1.25 });

        const ignored = getOrCreateStandardPipeline(engine, signature, bindings, biased);
        expect(createRenderPipeline.mock.calls[0]![0].depthStencil?.depthBias).toBeUndefined();
        enableStandardDepthBias();

        const plainPipeline = getOrCreateStandardPipeline(engine, signature, bindings, plain);
        const biasedPipeline = getOrCreateStandardPipeline(engine, signature, bindings, biased);
        const slopePipeline = getOrCreateStandardPipeline(engine, signature, bindings, slopeOnly);

        expect(biasedPipeline).not.toBe(plainPipeline);
        expect(plainPipeline).toBe(ignored);
        expect(slopePipeline).not.toBe(biasedPipeline);
        expect(createRenderPipeline).toHaveBeenCalledTimes(3);
        expect(createRenderPipeline.mock.calls[0]![0].depthStencil?.depthBias).toBeUndefined();
        expect(createRenderPipeline.mock.calls[1]![0].depthStencil).toMatchObject({
            depthBias: 2,
            depthBiasSlopeScale: 1.25,
        });
        expect(createRenderPipeline.mock.calls[2]![0].depthStencil).toMatchObject({
            depthBiasSlopeScale: 1.25,
        });
        expect(getOrCreateStandardPipeline(engine, signature, bindings, biased)).toBe(biasedPipeline);
    });
});
