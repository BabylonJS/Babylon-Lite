import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { createShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { clearShaderPipelineCache, enableShaderPipelineCache } from "../../../packages/babylon-lite/src/material/shader/shader-pipeline-cache";
import { getOrCreateShaderPipeline, getOrCreateShaderPipelineBindings } from "../../../packages/babylon-lite/src/material/shader/shader-pipeline";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";

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

function makeMaterial(fragment = "@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }") {
    return createShaderMaterial({
        vertexSource: "@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }",
        fragmentSource: fragment,
        attributes: ["position"],
        uniforms: ["world", { name: "tint", type: "vec3<f32>" }],
    });
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
        const second = makeMaterial("@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(0); }");
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
});
