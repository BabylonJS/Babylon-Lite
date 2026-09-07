import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { enableShaderMaterialInstanceWorld } from "../../../packages/babylon-lite/src/material/shader/enable-shader-material-instance-world";
import { createShaderNoColorMaterialView } from "../../../packages/babylon-lite/src/material/shader/no-color-view";
import { createShaderNormalMaterialView } from "../../../packages/babylon-lite/src/material/shader/normal-view";
import { createShaderMaterial, type ShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { clearShaderPipelineCache, enableShaderPipelineCache } from "../../../packages/babylon-lite/src/material/shader/shader-pipeline-cache";
import { getOrCreateShaderPipeline, getOrCreateShaderPipelineBindings } from "../../../packages/babylon-lite/src/material/shader/shader-pipeline";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";
import { wgsl, type WgslSource } from "../../../packages/babylon-lite/src/shader/wgsl";

function makeEngine() {
    const createBindGroupLayout = vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout);
    const createPipelineLayout = vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout);
    const createShaderModule = vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule);
    const createRenderPipeline = vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline);
    const device = {
        createBindGroupLayout,
        createPipelineLayout,
        createShaderModule,
        createRenderPipeline,
    } as unknown as GPUDevice;
    return {
        engine: { _device: device } as unknown as EngineContext,
        createBindGroupLayout,
        createPipelineLayout,
        createShaderModule,
        createRenderPipeline,
    };
}

function makeMaterial(fragment: WgslSource = wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`, blend?: GPUBlendState, topology?: GPUPrimitiveTopology) {
    const material = createShaderMaterial({
        vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
        fragmentSource: fragment,
        attributes: ["position"],
        uniforms: ["world", { name: "tint", type: "vec3<f32>" }],
        ...(blend ? { blend } : {}),
    });
    Object.assign(material, { _topology: topology });
    return material;
}

const signature = {
    _colorFormat: "rgba8unorm",
    _depthStencilFormat: "depth24plus",
    _sampleCount: 1,
} as RenderTargetSignature;

describe("ShaderMaterial pipeline cache", () => {
    it("shares layouts, modules, and pipelines across equivalent material instances", () => {
        clearShaderPipelineCache();
        clearSceneBGLCache();
        const { engine, createBindGroupLayout, createPipelineLayout, createShaderModule, createRenderPipeline } = makeEngine();
        const first = makeMaterial();
        const second = makeMaterial();
        enableShaderPipelineCache(engine, [{ material: first }, { material: second }]);
        const firstBindings = getOrCreateShaderPipelineBindings(engine, first);
        const firstPipeline = getOrCreateShaderPipeline(engine, signature, first, firstBindings);
        const counts = {
            bindGroupLayouts: createBindGroupLayout.mock.calls.length,
            pipelineLayouts: createPipelineLayout.mock.calls.length,
            shaderModules: createShaderModule.mock.calls.length,
            pipelines: createRenderPipeline.mock.calls.length,
        };

        const secondBindings = getOrCreateShaderPipelineBindings(engine, second);
        const secondPipeline = getOrCreateShaderPipeline(engine, signature, second, secondBindings);

        expect(secondBindings).toBe(firstBindings);
        expect(secondPipeline).toBe(firstPipeline);
        expect(createBindGroupLayout).toHaveBeenCalledTimes(counts.bindGroupLayouts);
        expect(createPipelineLayout).toHaveBeenCalledTimes(counts.pipelineLayouts);
        expect(createShaderModule).toHaveBeenCalledTimes(counts.shaderModules);
        expect(createRenderPipeline).toHaveBeenCalledTimes(counts.pipelines);
    });

    it("reuses the layout and unchanged vertex module when only fragment WGSL differs", () => {
        clearShaderPipelineCache();
        clearSceneBGLCache();
        const { engine, createPipelineLayout, createShaderModule, createRenderPipeline } = makeEngine();
        const first = makeMaterial();
        const second = makeMaterial(wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(0); }`);
        enableShaderPipelineCache(engine, [{ material: first }, { material: second }]);
        const firstBindings = getOrCreateShaderPipelineBindings(engine, first);
        getOrCreateShaderPipeline(engine, signature, first, firstBindings);

        const secondBindings = getOrCreateShaderPipelineBindings(engine, second);
        getOrCreateShaderPipeline(engine, signature, second, secondBindings);

        expect(secondBindings).toBe(firstBindings);
        expect(createPipelineLayout).toHaveBeenCalledTimes(1);
        expect(createShaderModule).toHaveBeenCalledTimes(3);
        expect(createRenderPipeline).toHaveBeenCalledTimes(2);
    });

    it("does not reuse shared cache objects from a lost device", () => {
        clearShaderPipelineCache();
        clearSceneBGLCache();
        const firstEngine = makeEngine();
        const recoveredEngine = makeEngine();
        const first = makeMaterial();
        const second = makeMaterial();
        const meshes = [{ material: first }, { material: second }];

        enableShaderPipelineCache(firstEngine.engine, meshes);
        const before = (first as unknown as { _shaderPipelineCache: object })._shaderPipelineCache;
        enableShaderPipelineCache(recoveredEngine.engine, meshes);
        const after = (first as unknown as { _shaderPipelineCache: object })._shaderPipelineCache;

        expect(after).not.toBe(before);
        expect((second as unknown as { _shaderPipelineCache: object })._shaderPipelineCache).toBe(after);
    });

    it("uses explicit blend overrides and keeps different states in separate pipelines", () => {
        clearShaderPipelineCache();
        clearSceneBGLCache();
        const { engine, createRenderPipeline } = makeEngine();
        const colorBlend = {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "zero", dstFactor: "zero", operation: "add" },
        } satisfies GPUBlendState;
        const additiveBlend = {
            color: { srcFactor: "one", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
        } satisfies GPUBlendState;
        const first = makeMaterial(undefined, colorBlend);
        const second = makeMaterial(undefined, additiveBlend);
        expect(first.needAlphaBlending).toBe(true);
        expect(first.depthWrite).toBe(false);
        enableShaderPipelineCache(engine, [{ material: first }, { material: second }]);

        getOrCreateShaderPipeline(engine, signature, first, getOrCreateShaderPipelineBindings(engine, first));
        getOrCreateShaderPipeline(engine, signature, second, getOrCreateShaderPipelineBindings(engine, second));

        expect(createRenderPipeline).toHaveBeenCalledTimes(2);
        const firstDescriptor = createRenderPipeline.mock.calls[0]![0];
        const secondDescriptor = createRenderPipeline.mock.calls[1]![0];
        const firstTarget = (firstDescriptor.fragment!.targets as GPUColorTargetState[])[0];
        const secondTarget = (secondDescriptor.fragment!.targets as GPUColorTargetState[])[0];
        expect(firstTarget?.blend).toEqual(colorBlend);
        expect(secondTarget?.blend).toEqual(additiveBlend);
    });

    it("keeps different primitive topologies in separate pipelines", () => {
        clearShaderPipelineCache();
        clearSceneBGLCache();
        const { engine, createRenderPipeline } = makeEngine();
        const triangles = makeMaterial(undefined, undefined, "triangle-list");
        const lines = makeMaterial(undefined, undefined, "line-list");
        enableShaderPipelineCache(engine, [{ material: triangles }, { material: lines }]);

        getOrCreateShaderPipeline(engine, signature, triangles, getOrCreateShaderPipelineBindings(engine, triangles));
        getOrCreateShaderPipeline(engine, signature, lines, getOrCreateShaderPipelineBindings(engine, lines));

        expect(createRenderPipeline).toHaveBeenCalledTimes(2);
        expect(createRenderPipeline.mock.calls[0]![0]!.primitive!.topology).toBe("triangle-list");
        expect(createRenderPipeline.mock.calls[1]![0]!.primitive!.topology).toBe("line-list");
    });

    it("specializes getFinalWorld for regular and thin-instanced pipelines", () => {
        clearSceneBGLCache();
        const { engine, createShaderModule } = makeEngine();
        const disabledMaterial = makeMaterial();
        getOrCreateShaderPipeline(engine, signature, disabledMaterial, getOrCreateShaderPipelineBindings(engine, disabledMaterial));
        expect(createShaderModule.mock.calls[0]![0].code).not.toContain("getFinalWorld");

        const material = createShaderMaterial({
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { let finalWorld = getFinalWorld(input); return finalWorld * vec4f(input.position, 1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
            attributes: ["position"],
            uniforms: ["world"],
        });
        enableShaderMaterialInstanceWorld(material);
        const bindings = getOrCreateShaderPipelineBindings(engine, material);

        getOrCreateShaderPipeline(engine, signature, material, bindings);
        const instanceAttrs = `@location(1) world0: vec4<f32>,
@location(2) world1: vec4<f32>,
@location(3) world2: vec4<f32>,
@location(4) world3: vec4<f32>,
`;
        const instanceLayout: GPUVertexBufferLayout = {
            arrayStride: 64,
            stepMode: "instance",
            attributes: [
                { shaderLocation: 1, offset: 0, format: "float32x4" },
                { shaderLocation: 2, offset: 16, format: "float32x4" },
                { shaderLocation: 3, offset: 32, format: "float32x4" },
                { shaderLocation: 4, offset: 48, format: "float32x4" },
            ],
        };
        getOrCreateShaderPipeline(engine, signature, material, bindings, "0", [...bindings.vertexBuffers, instanceLayout], instanceAttrs);

        const vertexSources = createShaderModule.mock.calls.map((call) => call[0].code).filter((code) => code.includes("@vertex fn mainVertex"));
        expect(vertexSources[1]).toContain("fn getFinalWorld(input: VertexInput) -> mat4x4<f32>");
        expect(vertexSources[1]).toContain("return shaderSystem.world;");
        expect(vertexSources[1]).not.toContain("input.world0");
        expect(vertexSources[2]).toContain("return shaderSystem.world * mat4x4<f32>(input.world0, input.world1, input.world2, input.world3);");
    });

    it("preserves getFinalWorld for ShaderMaterial views", () => {
        clearSceneBGLCache();
        const { engine, createShaderModule } = makeEngine();
        const material = createShaderMaterial({
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return getFinalWorld(input) * vec4f(input.position, 1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
            attributes: ["position"],
            uniforms: ["world"],
        });
        enableShaderMaterialInstanceWorld(material);
        const shadowView = createShaderNoColorMaterialView(material) as ShaderMaterial;
        const shadowSignature = {
            _colorFormat: null,
            _depthStencilFormat: "depth32float",
            _sampleCount: 1,
        } as RenderTargetSignature;

        getOrCreateShaderPipeline(engine, shadowSignature, shadowView, getOrCreateShaderPipelineBindings(engine, shadowView));
        const normalView = createShaderNormalMaterialView(material) as ShaderMaterial;
        getOrCreateShaderPipeline(engine, signature, normalView, getOrCreateShaderPipelineBindings(engine, normalView));

        const vertexSources = createShaderModule.mock.calls.map((call) => call[0].code).filter((code) => code.includes("@vertex fn mainVertex"));
        expect(vertexSources).toHaveLength(2);
        for (const source of vertexSources) {
            expect(source).toContain("fn getFinalWorld(input: VertexInput) -> mat4x4<f32>");
            expect(source).toContain("return shaderSystem.world;");
        }
    });

    it("rejects the instance-world helper without the world system uniform", () => {
        const material = createShaderMaterial({
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
            attributes: ["position"],
        });
        expect(() => enableShaderMaterialInstanceWorld(material)).toThrow('enableShaderMaterialInstanceWorld requires the ShaderMaterial to declare the "world" system uniform.');
    });
});
