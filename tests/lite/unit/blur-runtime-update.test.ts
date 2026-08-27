import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createRenderTarget, type RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { createBloomPostProcessTask } from "../../../packages/babylon-lite/src/post-process/bloom";
import { createBlurPostProcessTask } from "../../../packages/babylon-lite/src/post-process/blur";
import { createDepthOfFieldBlurPostProcessTask } from "../../../packages/babylon-lite/src/post-process/depth-of-field-blur";

interface MockTexture {
    createView(): GPUTextureView;
    destroy: ReturnType<typeof vi.fn>;
}

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

function makeMockEngine(): {
    engine: EngineContext;
    textures: MockTexture[];
    createTexture: ReturnType<typeof vi.fn>;
    createRenderPipeline: ReturnType<typeof vi.fn>;
    createBindGroup: ReturnType<typeof vi.fn<(descriptor: GPUBindGroupDescriptor) => GPUBindGroup>>;
    writeBuffer: ReturnType<typeof vi.fn>;
} {
    const textures: MockTexture[] = [];
    const createTexture = vi.fn(() => {
        const view = {} as GPUTextureView;
        const texture: MockTexture = {
            createView: () => view,
            destroy: vi.fn(),
        };
        textures.push(texture);
        return texture as unknown as GPUTexture;
    });
    const createRenderPipeline = vi.fn(() => ({}) as GPURenderPipeline);
    const createBindGroup = vi.fn((descriptor: GPUBindGroupDescriptor) => ({ descriptor }) as unknown as GPUBindGroup);
    const writeBuffer = vi.fn();
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
            queue: { writeBuffer },
        },
    } as unknown as EngineContext;
    return { engine, textures, createTexture, createRenderPipeline, createBindGroup, writeBuffer };
}

describe("blur runtime kernel updates", () => {
    it("rebuilds plain blur GPU state without replacing its output texture", () => {
        const { engine, textures, createTexture, createRenderPipeline, createBindGroup, writeBuffer } = makeMockEngine();
        const task = createBlurPostProcessTask({ sourceTexture: makeEagerTarget("source"), kernel: 9 }, engine);

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
        expect(textures[0]!.destroy).not.toHaveBeenCalled();
        expect(createRenderPipeline).toHaveBeenCalledTimes(2);
        expect(createBindGroup).toHaveBeenCalledTimes(2);
        expect(writeBuffer).toHaveBeenCalledTimes(2);
    });

    it("keeps bloom merge bound to the live blur texture after a kernel change", () => {
        const { engine, textures, createBindGroup } = makeMockEngine();
        const task = createBloomPostProcessTask({ sourceTexture: makeEagerTarget("source"), kernel: 9 }, engine) as ReturnType<typeof createBloomPostProcessTask> & {
            _blurYTarget: RenderTarget;
        };

        task.record();
        const blurTexture = task._blurYTarget._colorTexture;
        const blurView = task._blurYTarget._colorView;
        const mergeBindGroup = createBindGroup.mock.calls.map(([descriptor]) => descriptor).find((descriptor) => descriptor.label === "bloom-merge-bind-group");
        const boundBlurView = mergeBindGroup?.entries.find((entry) => entry.binding === 2)?.resource;

        task.kernel = 13;
        task.updateUniforms();

        expect(boundBlurView).toBe(blurView);
        expect(task._blurYTarget._colorTexture).toBe(blurTexture);
        expect(task._blurYTarget._colorView).toBe(boundBlurView);
        expect(textures.find((texture) => texture === (blurTexture as unknown as MockTexture))?.destroy).not.toHaveBeenCalled();
    });

    it("rebuilds depth-of-field blur GPU state without replacing its output texture", () => {
        const { engine, textures, createTexture, createRenderPipeline, createBindGroup, writeBuffer } = makeMockEngine();
        const task = createDepthOfFieldBlurPostProcessTask(
            {
                sourceTexture: makeEagerTarget("source"),
                circleOfConfusionTexture: makeEagerTarget("circle-of-confusion"),
                kernel: 9,
            },
            engine
        );

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
        expect(textures[0]!.destroy).not.toHaveBeenCalled();
        expect(createRenderPipeline).toHaveBeenCalledTimes(2);
        expect(createBindGroup).toHaveBeenCalledTimes(2);
        expect(writeBuffer).toHaveBeenCalledTimes(2);
    });
});
