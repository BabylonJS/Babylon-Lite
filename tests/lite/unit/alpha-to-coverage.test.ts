import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { getAlphaToCoverage, setAlphaToCoverage } from "../../../packages/babylon-lite/src/render/alpha-to-coverage";
import { _getAlphaToCoverageResolver } from "../../../packages/babylon-lite/src/render/alpha-to-coverage-hook";
import type { NodeMaterial } from "../../../packages/babylon-lite/src/material/node/node-material";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { clearPbrPipelineCache, getOrCreatePbrBindings, getOrCreatePbrPipeline } from "../../../packages/babylon-lite/src/material/pbr/pbr-pipeline";
import { createShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { clearShaderPipelineCache, enableShaderPipelineCache } from "../../../packages/babylon-lite/src/material/shader/shader-pipeline-cache";
import { getOrCreateShaderPipeline, getOrCreateShaderPipelineBindings } from "../../../packages/babylon-lite/src/material/shader/shader-pipeline";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import { clearStandardPipelineCache, getOrCreateStandardBindings, getOrCreateStandardPipeline } from "../../../packages/babylon-lite/src/material/standard/standard-pipeline";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";
import type { ComposedShader } from "../../../packages/babylon-lite/src/shader/fragment-types";
import { billboardBlendCutout } from "../../../packages/babylon-lite/src/sprite/billboard-blend";
import { createBillboardPipelineCache, getOrCreateBillboardPipeline } from "../../../packages/babylon-lite/src/sprite/billboard-pipeline";
import type { BillboardSpriteSystem } from "../../../packages/babylon-lite/src/sprite/billboard-sprite";
import { spriteBlendAlpha } from "../../../packages/babylon-lite/src/sprite/sprite-blend";
import type { Sprite2DLayer } from "../../../packages/babylon-lite/src/sprite/sprite-2d";
import { createSpritePipelineCache, getOrCreateSpritePipeline } from "../../../packages/babylon-lite/src/sprite/sprite-pipeline";
import { clearTextPipelineCache, getOrCreateTextPipeline } from "../../../packages/babylon-lite/src/text/_gpu/text-pipeline";
import type { TextRenderable } from "../../../packages/babylon-lite/src/text/text-renderable";
import blendedTextFragment from "../../../packages/babylon-lite/src/text/shaders/slug.frag.wgsl?raw";
import alphaToCoverageTextFragment from "../../../packages/babylon-lite/src/text/shaders/slug-a2c.frag.wgsl?raw";

function makeEngine() {
    const createRenderPipeline = vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline);
    const device = {
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const storage = new ArrayBuffer(Number(descriptor.size));
            return {
                getMappedRange: vi.fn(() => storage),
                unmap: vi.fn(),
            } as unknown as GPUBuffer;
        }),
        createRenderPipeline,
    } as unknown as GPUDevice;
    return { engine: { _device: device } as unknown as EngineContext, createRenderPipeline };
}

function makeShaderMaterial() {
    return createShaderMaterial({
        vertexSource: "@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }",
        fragmentSource: "@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }",
        attributes: ["position"],
    });
}

const multisampledSignature = {
    _colorFormat: "rgba8unorm",
    _depthStencilFormat: "depth24plus",
    _sampleCount: 4,
} as RenderTargetSignature;

const singleSampleSignature = {
    ...multisampledSignature,
    _sampleCount: 1,
} as RenderTargetSignature;

function alphaToCoverageEnabled(pipeline: GPURenderPipeline): boolean | undefined {
    return (pipeline as unknown as GPURenderPipelineDescriptor).multisample?.alphaToCoverageEnabled;
}

function colorTarget(pipeline: GPURenderPipeline): GPUColorTargetState {
    return (pipeline as unknown as GPURenderPipelineDescriptor).fragment!.targets![0]!;
}

describe("WebGPU alpha-to-coverage", () => {
    it("tracks requested state without attaching behavior to Material", () => {
        const material = makeShaderMaterial();
        expect(getAlphaToCoverage(material)).toBe(false);
        setAlphaToCoverage(material, true);
        expect(getAlphaToCoverage(material)).toBe(true);
        setAlphaToCoverage(material, false);
        expect(getAlphaToCoverage(material)).toBe(false);
    });

    it("rejects NodeMaterial as an unsupported public target", () => {
        const nodeMaterial = { _buildGroup: { _materialFamily: "node" } } as unknown as NodeMaterial;
        expect(() => {
            // @ts-expect-error NodeMaterial is deliberately excluded from the public setter.
            setAlphaToCoverage(nodeMaterial, true);
        }).toThrow("Alpha-to-coverage is not supported for NodeMaterial.");
    });

    it("enables only multisampled Shader pipelines and separates shared cache variants", () => {
        clearShaderPipelineCache();
        clearSceneBGLCache();
        const { engine, createRenderPipeline } = makeEngine();
        const enabled = makeShaderMaterial();
        const disabled = makeShaderMaterial();
        setAlphaToCoverage(enabled, true);
        enableShaderPipelineCache(engine, [{ material: enabled }, { material: disabled }]);

        const enabledBindings = getOrCreateShaderPipelineBindings(engine, enabled);
        const enabledPipeline = getOrCreateShaderPipeline(engine, multisampledSignature, enabled, enabledBindings);
        const disabledBindings = getOrCreateShaderPipelineBindings(engine, disabled);
        const disabledPipeline = getOrCreateShaderPipeline(engine, multisampledSignature, disabled, disabledBindings);
        const singleSamplePipeline = getOrCreateShaderPipeline(engine, singleSampleSignature, enabled, enabledBindings);

        expect(enabledBindings).toBe(disabledBindings);
        expect(enabledPipeline).not.toBe(disabledPipeline);
        expect(alphaToCoverageEnabled(enabledPipeline)).toBe(true);
        expect(alphaToCoverageEnabled(disabledPipeline)).not.toBe(true);
        expect(alphaToCoverageEnabled(singleSamplePipeline)).not.toBe(true);
        expect(createRenderPipeline).toHaveBeenCalledTimes(3);
    });

    it("enables and separates multisampled Standard pipeline variants", () => {
        clearStandardPipelineCache();
        clearSceneBGLCache();
        const { engine } = makeEngine();
        const material = createStandardMaterial();
        setAlphaToCoverage(material, true);

        const normalBindings = getOrCreateStandardBindings(engine, 0, 0);
        const enabledBindings = getOrCreateStandardBindings(engine, _getAlphaToCoverageResolver()?.(material) ? 1 << 23 : 0, 0);
        const normalPipeline = getOrCreateStandardPipeline(engine, multisampledSignature, normalBindings);
        const enabledPipeline = getOrCreateStandardPipeline(engine, multisampledSignature, enabledBindings);
        const singleSamplePipeline = getOrCreateStandardPipeline(engine, singleSampleSignature, enabledBindings);

        expect(enabledBindings).not.toBe(normalBindings);
        expect(enabledPipeline).not.toBe(normalPipeline);
        expect(alphaToCoverageEnabled(normalPipeline)).not.toBe(true);
        expect(alphaToCoverageEnabled(enabledPipeline)).toBe(true);
        expect(alphaToCoverageEnabled(singleSamplePipeline)).not.toBe(true);
    });

    it("keeps PBR A2C separate from sheen bit 29 and from the normal pipeline", () => {
        clearPbrPipelineCache();
        clearSceneBGLCache();
        const { engine } = makeEngine();
        const material = {} as PbrMaterialProps;
        setAlphaToCoverage(material, true);
        const composed = {
            _meshBGLDescriptor: { entries: [] },
            _vertexWGSL: "@vertex fn main() -> @builtin(position) vec4f { return vec4f(); }",
            _fragmentWGSL: "@fragment fn main() -> @location(0) vec4f { return vec4f(); }",
            _vertexBufferLayouts: [],
        } as unknown as ComposedShader;

        // Sheen roughness texture already owns features2 bit 29. A2C owns bit 31.
        const sheenBindings = getOrCreatePbrBindings(engine, 0, 1 << 29, 0, 0, composed);
        const enabledBindings = getOrCreatePbrBindings(engine, 0, (1 << 29) | (_getAlphaToCoverageResolver()?.(material) ? 1 << 31 : 0), 0, 0, composed);
        const sheenPipeline = getOrCreatePbrPipeline(engine, multisampledSignature, sheenBindings);
        const enabledPipeline = getOrCreatePbrPipeline(engine, multisampledSignature, enabledBindings);
        const singleSamplePipeline = getOrCreatePbrPipeline(engine, singleSampleSignature, enabledBindings);

        expect(enabledBindings).not.toBe(sheenBindings);
        expect(enabledPipeline).not.toBe(sheenPipeline);
        expect(alphaToCoverageEnabled(sheenPipeline)).not.toBe(true);
        expect(alphaToCoverageEnabled(enabledPipeline)).toBe(true);
        expect(alphaToCoverageEnabled(singleSamplePipeline)).not.toBe(true);
    });

    it("uses replacement color for depth-writing scene text and preserves the blended 1x variant", () => {
        const { engine } = makeEngine();
        clearTextPipelineCache(engine);
        const text = {} as TextRenderable;
        setAlphaToCoverage(text, true);

        const enabled = getOrCreateTextPipeline(engine, "rgba8unorm", 4, "depth24plus", true, text).pipeline;
        const singleSample = getOrCreateTextPipeline(engine, "rgba8unorm", 1, "depth24plus", true, text).pipeline;

        expect(alphaToCoverageEnabled(enabled)).toBe(true);
        expect(colorTarget(enabled).blend).toBeUndefined();
        expect(alphaToCoverageEnabled(singleSample)).not.toBe(true);
        expect(colorTarget(singleSample).blend?.color.srcFactor).toBe("one");
    });

    it("keeps blended and A2C text coverage math identical", () => {
        expect(alphaToCoverageTextFragment.replace("return vec4<f32>(in.vColor.rgb, in.vColor.a * coverage);", "return in.vColor * coverage;")).toBe(blendedTextFragment);
    });

    it("uses replacement color only for a multisampled depth-writing Sprite2D layer", () => {
        const { engine } = makeEngine();
        const cache = createSpritePipelineCache();
        const layer = { depth: "test-write", blendMode: spriteBlendAlpha } as Sprite2DLayer;
        const sceneLayout = {} as GPUBindGroupLayout;
        setAlphaToCoverage(layer, true);

        const enabled = getOrCreateSpritePipeline(engine, cache, "rgba8unorm", 4, spriteBlendAlpha, true, true, "depth24plus", sceneLayout, layer);
        const readOnlyDepth = getOrCreateSpritePipeline(engine, cache, "rgba8unorm", 4, spriteBlendAlpha, true, false, "depth24plus", sceneLayout, layer);

        expect(alphaToCoverageEnabled(enabled)).toBe(true);
        expect(colorTarget(enabled).blend).toBeUndefined();
        expect(alphaToCoverageEnabled(readOnlyDepth)).not.toBe(true);
        expect(colorTarget(readOnlyDepth).blend?.color.srcFactor).toBe("src-alpha");
    });

    it("replaces binary cutoff with sample coverage for multisampled cutout billboards", () => {
        const { engine } = makeEngine();
        const cache = createBillboardPipelineCache();
        const system = {
            _orientation: "facing",
            _depthMode: "cutout",
            blendMode: billboardBlendCutout,
        } as BillboardSpriteSystem;
        const sceneLayout = {} as GPUBindGroupLayout;
        setAlphaToCoverage(system, true);

        const enabled = getOrCreateBillboardPipeline(engine, cache, "rgba8unorm", 4, system, "depth24plus", sceneLayout);
        const singleSample = getOrCreateBillboardPipeline(engine, cache, "rgba8unorm", 1, system, "depth24plus", sceneLayout);
        const enabledShader = (enabled as unknown as GPURenderPipelineDescriptor).fragment!.module as unknown as GPUShaderModuleDescriptor;
        const singleSampleShader = (singleSample as unknown as GPURenderPipelineDescriptor).fragment!.module as unknown as GPUShaderModuleDescriptor;

        expect(alphaToCoverageEnabled(enabled)).toBe(true);
        expect(colorTarget(enabled).blend).toBeUndefined();
        expect(enabledShader.code).not.toContain("discard");
        expect(alphaToCoverageEnabled(singleSample)).not.toBe(true);
        expect(singleSampleShader.code).toContain("discard");
    });
});
