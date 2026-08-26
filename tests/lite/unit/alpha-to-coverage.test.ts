import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { getAlphaToCoverage, setAlphaToCoverage } from "../../../packages/babylon-lite/src/render/alpha-to-coverage";
import type { NodeMaterial } from "../../../packages/babylon-lite/src/material/node/node-material";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable";
import { clearPbrPipelineCache } from "../../../packages/babylon-lite/src/material/pbr/pbr-pipeline";
import { createShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { clearShaderPipelineCache, enableShaderPipelineCache } from "../../../packages/babylon-lite/src/material/shader/shader-pipeline-cache";
import { getOrCreateShaderPipeline, getOrCreateShaderPipelineBindings } from "../../../packages/babylon-lite/src/material/shader/shader-pipeline";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import { buildStandardMeshRenderables } from "../../../packages/babylon-lite/src/material/standard/standard-renderable";
import { clearStandardPipelineCache } from "../../../packages/babylon-lite/src/material/standard/standard-pipeline";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";
import { billboardBlendCutout } from "../../../packages/babylon-lite/src/sprite/billboard-blend";
import { createBillboardPipelineCache, getOrCreateBillboardPipeline } from "../../../packages/babylon-lite/src/sprite/billboard-pipeline";
import type { BillboardSpriteSystem } from "../../../packages/babylon-lite/src/sprite/billboard-sprite";
import { spriteBlendAdditive, spriteBlendAlpha, spriteBlendOpaque } from "../../../packages/babylon-lite/src/sprite/sprite-blend";
import type { Sprite2DLayer } from "../../../packages/babylon-lite/src/sprite/sprite-2d";
import { createSpritePipelineCache, getOrCreateSpritePipeline } from "../../../packages/babylon-lite/src/sprite/sprite-pipeline";
import { clearTextPipelineCache, getOrCreateTextPipeline } from "../../../packages/babylon-lite/src/text/_gpu/text-pipeline";
import type { TextRenderable } from "../../../packages/babylon-lite/src/text/text-renderable";

function makeEngine() {
    const createRenderPipeline = vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline);
    const createShaderModule = vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule);
    const device = {
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule,
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup),
        createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => descriptor as unknown as GPUSampler),
        createTexture: vi.fn(() => {
            const texture = {
                createView: vi.fn(() => ({}) as GPUTextureView),
                destroy: vi.fn(),
            };
            return texture as unknown as GPUTexture;
        }),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const storage = new ArrayBuffer(Number(descriptor.size));
            return {
                getMappedRange: vi.fn(() => storage),
                unmap: vi.fn(),
            } as unknown as GPUBuffer;
        }),
        queue: {
            writeBuffer: vi.fn(),
            writeTexture: vi.fn(),
        },
        createRenderPipeline,
    } as unknown as GPUDevice;
    const engine = { _device: device, _disposables: [] } as unknown as EngineContext;
    Object.assign(engine, { engine });
    return { engine, createRenderPipeline, createShaderModule };
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

function meshBindGroupLayout(pipeline: GPURenderPipeline): GPUBindGroupLayout {
    const descriptor = pipeline as unknown as GPURenderPipelineDescriptor;
    return (descriptor.layout as unknown as GPUPipelineLayoutDescriptor).bindGroupLayouts[1]!;
}

function makeShaderMaterial(options?: { needAlphaBlending?: boolean; depthWrite?: boolean }) {
    return createShaderMaterial({
        vertexSource: "@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }",
        fragmentSource: "@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }",
        attributes: ["position"],
        ...options,
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

function fragmentStage(pipeline: GPURenderPipeline): GPUFragmentState {
    return (pipeline as unknown as GPURenderPipelineDescriptor).fragment!;
}

function depthWriteEnabled(pipeline: GPURenderPipeline): boolean | undefined {
    return (pipeline as unknown as GPURenderPipelineDescriptor).depthStencil?.depthWriteEnabled;
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

    it("routes the public setter through Standard renderables without duplicating shader bindings", () => {
        clearStandardPipelineCache();
        clearSceneBGLCache();
        const { engine, createShaderModule } = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const enabledMaterial = createStandardMaterial();
        const normalMaterial = createStandardMaterial();
        setAlphaToCoverage(enabledMaterial, true);
        const { renderables } = buildStandardMeshRenderables(scene, [makeMesh(enabledMaterial), makeMesh(normalMaterial)], { sceneShader: null });

        const enabledPipeline = renderables[0]!.bind(engine, multisampledSignature).pipeline;
        const normalPipeline = renderables[1]!.bind(engine, multisampledSignature).pipeline;
        const singleSamplePipeline = renderables[0]!.bind(engine, singleSampleSignature).pipeline;

        expect(enabledPipeline).not.toBe(normalPipeline);
        expect(meshBindGroupLayout(enabledPipeline)).toBe(meshBindGroupLayout(normalPipeline));
        expect(alphaToCoverageEnabled(normalPipeline)).not.toBe(true);
        expect(alphaToCoverageEnabled(enabledPipeline)).toBe(true);
        expect(alphaToCoverageEnabled(singleSamplePipeline)).not.toBe(true);
        expect(createShaderModule).toHaveBeenCalledTimes(2);
    });

    it("routes the public setter through PBR renderables without duplicating shader bindings", async () => {
        clearPbrPipelineCache();
        clearSceneBGLCache();
        const { engine, createShaderModule } = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const enabledMaterial = createPbrMaterial();
        const normalMaterial = createPbrMaterial();
        setAlphaToCoverage(enabledMaterial, true);
        const meshes = [makeMesh(enabledMaterial), makeMesh(normalMaterial)];
        scene._groups.set(enabledMaterial._buildGroup, meshes);
        const { renderables } = await buildPbrRenderables(scene, meshes, undefined);

        const enabledPipeline = renderables[0]!.bind(engine, multisampledSignature).pipeline;
        const normalPipeline = renderables[1]!.bind(engine, multisampledSignature).pipeline;
        const singleSamplePipeline = renderables[0]!.bind(engine, singleSampleSignature).pipeline;

        expect(enabledPipeline).not.toBe(normalPipeline);
        expect(meshBindGroupLayout(enabledPipeline)).toBe(meshBindGroupLayout(normalPipeline));
        expect(alphaToCoverageEnabled(normalPipeline)).not.toBe(true);
        expect(alphaToCoverageEnabled(enabledPipeline)).toBe(true);
        expect(alphaToCoverageEnabled(singleSamplePipeline)).not.toBe(true);
        expect(createShaderModule).toHaveBeenCalledTimes(2);
    });

    it("keeps material blending and depth policy independent from A2C", async () => {
        clearShaderPipelineCache();
        clearStandardPipelineCache();
        clearPbrPipelineCache();
        clearSceneBGLCache();
        const { engine } = makeEngine();

        const depthWritingShader = makeShaderMaterial({ needAlphaBlending: true, depthWrite: true });
        setAlphaToCoverage(depthWritingShader, true);
        const depthWritingShaderBindings = getOrCreateShaderPipelineBindings(engine, depthWritingShader);
        const depthWritingShaderPipeline = getOrCreateShaderPipeline(engine, multisampledSignature, depthWritingShader, depthWritingShaderBindings);

        const readOnlyDepthShader = makeShaderMaterial({ needAlphaBlending: true });
        setAlphaToCoverage(readOnlyDepthShader, true);
        const readOnlyDepthShaderBindings = getOrCreateShaderPipelineBindings(engine, readOnlyDepthShader);
        const readOnlyDepthShaderPipeline = getOrCreateShaderPipeline(engine, multisampledSignature, readOnlyDepthShader, readOnlyDepthShaderBindings);

        const standard = createStandardMaterial();
        standard.alpha = 0.5;
        setAlphaToCoverage(standard, true);
        const standardScene = createSceneContext(engine, { defaultRenderTask: false });
        const standardPipeline = buildStandardMeshRenderables(standardScene, [makeMesh(standard)], { sceneShader: null }).renderables[0]!.bind(
            engine,
            multisampledSignature
        ).pipeline;

        const pbr = createPbrMaterial({ alphaBlend: true, alpha: 0.5 });
        setAlphaToCoverage(pbr, true);
        const pbrScene = createSceneContext(engine, { defaultRenderTask: false });
        const pbrMeshes = [makeMesh(pbr)];
        pbrScene._groups.set(pbr._buildGroup, pbrMeshes);
        const pbrPipeline = (await buildPbrRenderables(pbrScene, pbrMeshes, undefined)).renderables[0]!.bind(engine, multisampledSignature).pipeline;

        expect(alphaToCoverageEnabled(depthWritingShaderPipeline)).toBe(true);
        expect(colorTarget(depthWritingShaderPipeline).blend).toBeDefined();
        expect(depthWriteEnabled(depthWritingShaderPipeline)).toBe(true);
        for (const pipeline of [readOnlyDepthShaderPipeline, standardPipeline, pbrPipeline]) {
            expect(alphaToCoverageEnabled(pipeline)).toBe(true);
            expect(colorTarget(pipeline).blend).toBeDefined();
            expect(depthWriteEnabled(pipeline)).toBe(false);
        }
    });

    it("uses replacement color for depth-writing scene text and preserves the blended 1x variant", () => {
        const { engine } = makeEngine();
        clearTextPipelineCache(engine);
        const text = {} as TextRenderable;
        setAlphaToCoverage(text, true);

        const enabled = getOrCreateTextPipeline(engine, "rgba8unorm", 4, "depth24plus", true, text)._pipeline;
        const singleSample = getOrCreateTextPipeline(engine, "rgba8unorm", 1, "depth24plus", true, text)._pipeline;

        expect(alphaToCoverageEnabled(enabled)).toBe(true);
        expect(colorTarget(enabled).blend).toBeUndefined();
        expect(alphaToCoverageEnabled(singleSample)).not.toBe(true);
        expect(colorTarget(singleSample).blend?.color.srcFactor).toBe("one");
    });

    it("keeps blended and A2C text coverage math identical", () => {
        // Both pipelines run ONE shader module, specialised by the `a2c` pipeline-overridable
        // constant, so the coverage math cannot drift between them. Shipping a second
        // near-identical shader file instead would inline ~3KB of duplicate WGSL text into
        // every consumer's bundle, including those that never enable A2C.
        const { engine, createShaderModule } = makeEngine();
        clearTextPipelineCache(engine);
        const text = {} as TextRenderable;
        setAlphaToCoverage(text, true);

        const enabled = getOrCreateTextPipeline(engine, "rgba8unorm", 4, "depth24plus", true, text)._pipeline;
        const blended = getOrCreateTextPipeline(engine, "rgba8unorm", 1, "depth24plus", true, text)._pipeline;

        expect(fragmentStage(enabled).module).toBe(fragmentStage(blended).module);
        expect(fragmentStage(enabled).constants).toEqual({ 0: 1 });
        expect(fragmentStage(blended).constants).toBeUndefined();

        // The key must stay numeric. An unquoted identifier key is property-mangled by Closure
        // ADVANCED while the WGSL string keeps `a2c`, so a name-keyed constant would break
        // pipeline creation for A2C consumers built with it.
        expect(Object.keys(fragmentStage(enabled).constants!)).toEqual(["0"]);

        // Exactly one fragment module is ever compiled, and the source actually handed to
        // createShaderModule — not merely the file on disk — declares the override that the
        // A2C pipeline specialises, under the numeric id the descriptor keys it by.
        const fragmentSources = createShaderModule.mock.calls.map((call) => call[0].code).filter((code) => code.includes("@location(0) vec4<f32>"));
        expect(fragmentSources).toHaveLength(1);
        expect(fragmentSources[0]).toMatch(/@id\(0\)\s+override\s+a2c\s*:\s*bool/);
    });

    it("combines multisampled depth-writing Sprite2D A2C with the selected blend mode", () => {
        const { engine } = makeEngine();
        const cache = createSpritePipelineCache();
        const layer = { depth: "test-write", blendMode: spriteBlendOpaque } as Sprite2DLayer;
        const sceneLayout = {} as GPUBindGroupLayout;
        setAlphaToCoverage(layer, true);

        const enabled = getOrCreateSpritePipeline(engine, cache, "rgba8unorm", 4, spriteBlendOpaque, true, true, "depth24plus", sceneLayout, layer);
        const additive = getOrCreateSpritePipeline(engine, cache, "rgba8unorm", 4, spriteBlendAdditive, true, true, "depth24plus", sceneLayout, layer);
        const readOnlyDepth = getOrCreateSpritePipeline(engine, cache, "rgba8unorm", 4, spriteBlendAlpha, true, false, "depth24plus", sceneLayout, layer);

        expect(alphaToCoverageEnabled(enabled)).toBe(true);
        expect(colorTarget(enabled).blend).toBeUndefined();
        expect(alphaToCoverageEnabled(additive)).toBe(true);
        expect(colorTarget(additive).blend).toEqual(spriteBlendAdditive._descriptor);
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
