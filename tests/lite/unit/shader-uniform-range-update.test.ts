import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { createShaderMaterial, setShaderFloat, setShaderUniform } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { enableShaderUniformRangeUpdates } from "../../../packages/babylon-lite/src/material/shader/shader-uniform-range";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { UniformCopyBatch } from "../../../packages/babylon-lite/src/render/uniform-copy-batch";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { UboSpec } from "../../../packages/babylon-lite/src/shader/fragment-types";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage" | "GPUShaderStage"> & {
    GPUBufferUsage?: { UNIFORM: number; COPY_DST: number };
    GPUShaderStage?: { VERTEX: number; FRAGMENT: number };
};
gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 } as unknown as GPUBufferUsage;
gpuGlobals.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 } as unknown as GPUShaderStage;

interface FakeBuffer extends GPUBuffer {
    _label?: string;
}

function fixture(getUniformBatch?: () => UniformCopyBatch, enabled = true) {
    const buffers: FakeBuffer[] = [];
    const writeBuffer = vi.fn();
    const device = {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const buffer = {
                _label: descriptor.label,
                size: descriptor.size,
                destroy: vi.fn(),
            } as unknown as FakeBuffer;
            buffers.push(buffer);
            return buffer;
        }),
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
        queue: { writeBuffer },
    } as unknown as GPUDevice;
    const engine = {
        _device: device,
        canvas: { width: 64, height: 64 },
    } as unknown as EngineContext;
    const material = createShaderMaterial({
        vertexSource: "@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }",
        fragmentSource: "@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(material.tint, material.amount); }",
        attributes: ["position"],
        uniforms: [
            { name: "amount", type: "f32" },
            { name: "count", type: "u32" },
            { name: "delta", type: "i32" },
            { name: "tint", type: "vec3<f32>" },
        ],
    });
    const mesh = {
        name: "range",
        children: [],
        material,
        receiveShadows: false,
        _gpu: {
            positionBuffer: {} as GPUBuffer,
            normalBuffer: {} as GPUBuffer,
            uvBuffer: {} as GPUBuffer,
            indexBuffer: {} as GPUBuffer,
            indexCount: 3,
            indexFormat: "uint32",
        },
    } as unknown as Mesh;
    initMeshTransform(mesh);
    const scene = {
        surface: { engine },
        camera: null,
        _beforeRender: [],
        _meshDisposables: new Map(),
        _meshAuxDisposables: new Map(),
    } as unknown as SceneContext;
    if (enabled) {
        enableShaderUniformRangeUpdates(scene, material);
    }
    const result = buildShaderMaterialRenderables(scene, [mesh], getUniformBatch ? () => getUniformBatch() : undefined);
    const binding = result.renderables[0]!.bind(engine, { _colorFormat: "rgba8unorm", _sampleCount: 1 } as RenderTargetSignature);
    const customBuffer = buffers.find((buffer) => buffer._label === "shader-custom-ubo")!;
    const customSpec = (material as unknown as { _shaderCustomSpec: UboSpec })._shaderCustomSpec;
    writeBuffer.mockClear();
    return { binding, customBuffer, customSpec, engine, material, scene, writeBuffer };
}

describe("ShaderMaterial ranged custom UBO updates", () => {
    it("keeps whole-buffer updates when the optimization is not enabled", () => {
        const { binding, customBuffer, customSpec, material, writeBuffer } = fixture(undefined, false);

        setShaderFloat(material, "amount", 0.25);
        binding.update!({ targetWidth: 64, targetHeight: 64 });

        const customWrite = writeBuffer.mock.calls.find((call) => call[0] === customBuffer)!;
        expect(customWrite[1]).toBe(0);
        expect((customWrite[2] as Uint8Array).byteLength).toBe(customSpec._totalBytes);
    });

    it("uploads only one changed scalar and skips unchanged values", () => {
        const { binding, customBuffer, customSpec, material, scene, writeBuffer } = fixture();
        const amountOffset = customSpec._offsets.get("amount")!;

        setShaderFloat(material, "amount", 0.25);
        scene._beforeRender[0]!(0);
        binding.update!({ targetWidth: 64, targetHeight: 64 });

        const customWrite = writeBuffer.mock.calls.find((call) => call[0] === customBuffer)!;
        expect(customWrite[1]).toBe(amountOffset);
        expect(customWrite[4]).toBe(4);
        expect(new Float32Array(customWrite[2] as ArrayBuffer, customWrite[3] as number, 1)[0]).toBe(0.25);

        writeBuffer.mockClear();
        setShaderFloat(material, "amount", 0.25);
        binding.update!({ targetWidth: 64, targetHeight: 64 });
        expect(writeBuffer.mock.calls.some((call) => call[0] === customBuffer)).toBe(false);
    });

    it("lands integer values and merges separated changes into one valid span", () => {
        const { binding, customBuffer, customSpec, material, scene, writeBuffer } = fixture();
        const countOffset = customSpec._offsets.get("count")!;
        const tintOffset = customSpec._offsets.get("tint")!;

        setShaderUniform(material, "count", 7);
        setShaderUniform(material, "delta", -3);
        setShaderUniform(material, "tint", [0.1, 0.2, 0.3]);
        scene._beforeRender[0]!(0);
        binding.update!({ targetWidth: 64, targetHeight: 64 });

        const customWrite = writeBuffer.mock.calls.find((call) => call[0] === customBuffer)!;
        const data = customWrite[2] as ArrayBuffer;
        const sourceOffset = customWrite[3] as number;
        expect(customWrite[1]).toBe(countOffset);
        expect(customWrite[4]).toBe(tintOffset + 12 - countOffset);
        expect(new Uint32Array(data, sourceOffset, 1)[0]).toBe(7);
        expect(new Int32Array(data, sourceOffset + 4, 1)[0]).toBe(-3);
    });

    it("flushes directly before render without duplicating the custom UBO through UniformCopyBatch", () => {
        const queue = vi.fn();
        const batch = {
            queue,
            reset: vi.fn(),
            flush: vi.fn(),
            destroy: vi.fn(),
        } as unknown as UniformCopyBatch;
        const { binding, customBuffer, customSpec, material, scene, writeBuffer } = fixture(() => batch);
        const amountOffset = customSpec._offsets.get("amount")!;

        setShaderFloat(material, "amount", 0.5);
        scene._beforeRender[0]!(0);
        binding.update!({ targetWidth: 64, targetHeight: 64 });

        const customCopies = queue.mock.calls.filter((call) => call[0] === customBuffer);
        expect(customCopies).toHaveLength(0);
        const customWrite = writeBuffer.mock.calls.find((call) => call[0] === customBuffer)!;
        expect(customWrite[1]).toBe(amountOffset);
        expect(customWrite[4]).toBe(4);
    });

    it("runs after public before-render uniform setters regardless of enable order", () => {
        const first = fixture(undefined, false);
        first.scene._beforeRender.unshift(() => setShaderFloat(first.material, "amount", 0.6));
        enableShaderUniformRangeUpdates(first.scene, first.material);
        first.writeBuffer.mockClear();
        for (const callback of first.scene._beforeRender) {
            callback(0);
        }
        expect(first.writeBuffer.mock.calls.find((call) => call[0] === first.customBuffer)![4]).toBe(4);

        const second = fixture();
        second.scene._beforeRender.unshift(() => setShaderFloat(second.material, "amount", 0.7));
        second.writeBuffer.mockClear();
        for (const callback of second.scene._beforeRender) {
            callback(0);
        }
        expect(second.writeBuffer.mock.calls.find((call) => call[0] === second.customBuffer)![4]).toBe(4);
    });

    it("preserves typed-array methods and tracks direct mutating methods", () => {
        const { customBuffer, material, scene, writeBuffer } = fixture();
        const tint = material._uniformValues.get("tint")!.value;

        expect(() => [...tint]).not.toThrow();
        expect(tint.slice(0, 1)[0]).toBe(0);
        tint.set([0.2, 0.4, 0.6]);
        tint.subarray(1).fill(0.8);
        scene._beforeRender[0]!(0);

        const customWrite = writeBuffer.mock.calls.find((call) => call[0] === customBuffer)!;
        expect(customWrite[4]).toBe(12);
    });

    it("preserves one version increment per public uniform setter", () => {
        const { material } = fixture();
        const version = material._uniformVersion;

        setShaderUniform(material, "tint", [0.2, 0.4, 0.6]);

        expect(material._uniformVersion).toBe(version + 1);
        expect(material._uboVersion).toBe(material._uniformVersion);
    });

    it("registers once per scene and can re-register after scene callbacks are cleared", () => {
        const first = fixture();
        const secondScene = {
            ...first.scene,
            _beforeRender: [],
        } as SceneContext;

        enableShaderUniformRangeUpdates(first.scene, first.material);
        enableShaderUniformRangeUpdates(secondScene, first.material);
        expect(first.scene._beforeRender).toHaveLength(1);
        expect(secondScene._beforeRender).toHaveLength(1);

        first.scene._beforeRender.length = 0;
        enableShaderUniformRangeUpdates(first.scene, first.material);
        expect(first.scene._beforeRender).toHaveLength(1);
    });
});
