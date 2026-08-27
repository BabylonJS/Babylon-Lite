import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createRenderTarget, type RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { createBlurPostProcessTask } from "../../../packages/babylon-lite/src/post-process/blur";

function makeEagerTarget(label: string): RenderTarget {
    const target = createRenderTarget({ lbl: label, format: "rgba8unorm", samples: 1, size: { width: 64, height: 32 } });
    Object.assign(target, {
        _eager: true,
        _colorTexture: { destroy: vi.fn() } as unknown as GPUTexture,
        _colorView: {} as GPUTextureView,
        _width: 64,
        _height: 32,
    });
    return target;
}

describe("blur runtime kernel updates", () => {
    it("rebuilds shader GPU state without recording again or replacing the output target", () => {
        const outputTextures: Array<{ createView(): GPUTextureView; destroy: ReturnType<typeof vi.fn> }> = [];
        const createTexture = vi.fn(() => {
            const texture = {
                createView: () => ({}) as GPUTextureView,
                destroy: vi.fn(),
            };
            outputTextures.push(texture);
            return texture as unknown as GPUTexture;
        });
        const createRenderPipeline = vi.fn(() => ({}) as GPURenderPipeline);
        const createBindGroup = vi.fn(() => ({}) as GPUBindGroup);
        const engine = {
            _device: {
                createBuffer: vi.fn(() => ({ destroy: vi.fn() }) as unknown as GPUBuffer),
                createBindGroupLayout: vi.fn(() => ({}) as GPUBindGroupLayout),
                createPipelineLayout: vi.fn(() => ({}) as GPUPipelineLayout),
                createShaderModule: vi.fn(() => ({}) as GPUShaderModule),
                createRenderPipeline,
                createBindGroup,
                createSampler: vi.fn(() => ({}) as GPUSampler),
                createTexture,
                queue: { writeBuffer: vi.fn() },
            },
        } as unknown as EngineContext;
        const source = makeEagerTarget("source");
        const task = createBlurPostProcessTask({ sourceTexture: source, kernel: 9 }, engine);

        task.record();
        const outputTexture = task.outputTexture;
        const outputGpuTexture = task.outputTexture._colorTexture;
        const record = vi.spyOn(task, "record");

        task.kernel = 13;
        task.updateUniforms();

        expect(record).not.toHaveBeenCalled();
        expect(task.outputTexture).toBe(outputTexture);
        expect(task.outputTexture._colorTexture).toBe(outputGpuTexture);
        expect(createTexture).toHaveBeenCalledTimes(1);
        expect(outputTextures[0]!.destroy).not.toHaveBeenCalled();
        expect(createRenderPipeline).toHaveBeenCalledTimes(2);
        expect(createBindGroup).toHaveBeenCalledTimes(2);
    });
});
