import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { createShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { getOrCreateShaderPipeline, getOrCreateShaderPipelineBindings } from "../../../packages/babylon-lite/src/material/shader/shader-pipeline";
import { _enableShaderVb, setShaderAttributeFormats } from "../../../packages/babylon-lite/src/material/shader/shader-vb";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";

function makeEngine(): { engine: EngineContext; createShaderModule: ReturnType<typeof vi.fn> } {
    const createShaderModule = vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule);
    const device = {
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule,
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
    } as unknown as GPUDevice;
    return { engine: { _device: device } as unknown as EngineContext, createShaderModule };
}

const signature = { _colorFormat: "rgba8unorm", _sampleCount: 1 } as RenderTargetSignature;
const FORMAT_CASES = [
    // uint* → u32 / vecN<u32>
    ["uint8", "u32", 4],
    ["uint8x2", "vec2<u32>", 4],
    ["uint8x4", "vec4<u32>", 4],
    ["uint16", "u32", 4],
    ["uint16x2", "vec2<u32>", 4],
    ["uint16x4", "vec4<u32>", 8],
    ["uint32", "u32", 4],
    ["uint32x2", "vec2<u32>", 8],
    ["uint32x3", "vec3<u32>", 12],
    ["uint32x4", "vec4<u32>", 16],
    // sint* → i32 / vecN<i32>
    ["sint8", "i32", 4],
    ["sint8x2", "vec2<i32>", 4],
    ["sint8x4", "vec4<i32>", 4],
    ["sint16", "i32", 4],
    ["sint16x2", "vec2<i32>", 4],
    ["sint16x4", "vec4<i32>", 8],
    ["sint32", "i32", 4],
    ["sint32x2", "vec2<i32>", 8],
    ["sint32x3", "vec3<i32>", 12],
    ["sint32x4", "vec4<i32>", 16],
    // normalized/float/packed → f32 / vecN<f32>
    ["unorm8", "f32", 4],
    ["unorm8x2", "vec2<f32>", 4],
    ["unorm8x4", "vec4<f32>", 4],
    ["snorm8", "f32", 4],
    ["snorm8x2", "vec2<f32>", 4],
    ["snorm8x4", "vec4<f32>", 4],
    ["unorm16", "f32", 4],
    ["unorm16x2", "vec2<f32>", 4],
    ["unorm16x4", "vec4<f32>", 8],
    ["snorm16", "f32", 4],
    ["snorm16x2", "vec2<f32>", 4],
    ["snorm16x4", "vec4<f32>", 8],
    ["float16", "f32", 4],
    ["float16x2", "vec2<f32>", 4],
    ["float16x4", "vec4<f32>", 8],
    ["float32", "f32", 4],
    ["float32x2", "vec2<f32>", 8],
    ["float32x3", "vec3<f32>", 12],
    ["float32x4", "vec4<f32>", 16],
    // packed 4-component forms without an "xN" suffix
    ["unorm10-10-10-2", "vec4<f32>", 4],
    ["unorm8x4-bgra", "vec4<f32>", 4],
] satisfies [GPUVertexFormat, string, number][];

/** Build a one-attribute ShaderMaterial declaring `format` for `position`, compile its pipeline,
 *  and return the generated vertex-shader WGSL — the same code path `_installShaderVbSupport`'s
 *  `_wgslType` hook feeds into `buildShaderPrelude`. */
function vertexWgslFor(format: GPUVertexFormat): string {
    clearSceneBGLCache();
    const { engine, createShaderModule } = makeEngine();
    const material = createShaderMaterial({
        vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }`,
        fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
        attributes: ["position"],
    });
    setShaderAttributeFormats(material, { position: format });
    const bindings = getOrCreateShaderPipelineBindings(engine, material);
    getOrCreateShaderPipeline(engine, signature, material, bindings);
    return createShaderModule.mock.calls[0]![0]!.code as string;
}

describe("shader-vb wgslTypeForFormat", () => {
    it.each(FORMAT_CASES)("maps %s to WGSL %s", (format, expectedType, _expectedStride) => {
        _enableShaderVb();
        const code = vertexWgslFor(format);
        expect(code).toContain(`position: ${expectedType},`);
    });

    it.each(FORMAT_CASES)("uses the exact tight stride for format %s", (format, _expectedType, expectedStride) => {
        _enableShaderVb();
        const { engine } = makeEngine();
        const material = createShaderMaterial({
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
            attributes: ["position"],
        });
        setShaderAttributeFormats(material, { position: format });

        const bindings = getOrCreateShaderPipelineBindings(engine, material);

        expect(bindings.vertexBuffers[0]!.arrayStride).toBe(expectedStride);
        expect(bindings.vertexBuffers[0]!.arrayStride % 4).toBe(0);
    });
});
