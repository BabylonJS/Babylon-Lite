import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { decodeBrdfPng, uploadCubemapRGBD as uploadEnvCubemapRGBD } from "../../../packages/babylon-lite/src/loader-env/rgbd-decode";
import { uploadCubemapRGBD as uploadIblCubemapRGBD } from "../../../packages/babylon-lite/src/loader-gltf/ibl-cubemap-upload";

function makeEngine(): {
    engine: EngineContext;
    computeDescriptors: GPUComputePipelineDescriptor[];
    shaderDescriptors: GPUShaderModuleDescriptor[];
} {
    const computeDescriptors: GPUComputePipelineDescriptor[] = [];
    const shaderDescriptors: GPUShaderModuleDescriptor[] = [];
    const pipeline = {
        getBindGroupLayout: vi.fn(() => ({}) as GPUBindGroupLayout),
    } as unknown as GPUComputePipeline;
    const createTexture = vi.fn(
        () =>
            ({
                createView: vi.fn(() => ({}) as GPUTextureView),
                destroy: vi.fn(),
            }) as unknown as GPUTexture
    );
    const commandEncoder = {
        beginComputePass: vi.fn(
            () =>
                ({
                    setPipeline: vi.fn(),
                    setBindGroup: vi.fn(),
                    dispatchWorkgroups: vi.fn(),
                    end: vi.fn(),
                }) as unknown as GPUComputePassEncoder
        ),
        copyTextureToTexture: vi.fn(),
        finish: vi.fn(() => ({}) as GPUCommandBuffer),
    } as unknown as GPUCommandEncoder;
    const device = {
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => {
            shaderDescriptors.push(descriptor);
            return descriptor as unknown as GPUShaderModule;
        }),
        createComputePipeline: vi.fn((descriptor: GPUComputePipelineDescriptor) => {
            computeDescriptors.push(descriptor);
            return pipeline;
        }),
        createTexture,
        createBindGroup: vi.fn(() => ({}) as GPUBindGroup),
        createCommandEncoder: vi.fn(() => commandEncoder),
        queue: {
            copyExternalImageToTexture: vi.fn(),
            submit: vi.fn(),
        },
    } as unknown as GPUDevice;

    return {
        engine: { _device: device } as unknown as EngineContext,
        computeDescriptors,
        shaderDescriptors,
    };
}

function expectNumericFlipOverride(shaderDescriptor: GPUShaderModuleDescriptor, computeDescriptor: GPUComputePipelineDescriptor, value: 0 | 1): void {
    expect(shaderDescriptor.code).toMatch(/@id\(0\)\s*override\s+f\s*:\s*bool/);
    expect(computeDescriptor.compute.constants).toEqual({ 0: value });
    expect(Object.keys(computeDescriptor.compute.constants!)).toEqual(["0"]);
}

describe("RGBD pipeline constants", () => {
    it("keys the environment decoder's flip variants by numeric WGSL id", () => {
        const { engine, computeDescriptors, shaderDescriptors } = makeEngine();

        decodeBrdfPng(engine, { width: 1, height: 1 } as ImageBitmap);
        uploadEnvCubemapRGBD(engine, [], 1, 1);

        expect(shaderDescriptors).toHaveLength(1);
        expect(computeDescriptors).toHaveLength(2);
        expectNumericFlipOverride(shaderDescriptors[0]!, computeDescriptors[0]!, 0);
        expectNumericFlipOverride(shaderDescriptors[0]!, computeDescriptors[1]!, 1);
    });

    it("keys the glTF image-based-light uploader's flip override by numeric WGSL id", () => {
        const { engine, computeDescriptors, shaderDescriptors } = makeEngine();

        uploadIblCubemapRGBD(engine, [], 1, 1);

        expect(shaderDescriptors).toHaveLength(1);
        expect(computeDescriptors).toHaveLength(1);
        expectNumericFlipOverride(shaderDescriptors[0]!, computeDescriptors[0]!, 1);
    });
});
