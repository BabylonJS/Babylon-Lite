import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target.js";
import { createSmaaPostProcessTask } from "../../../packages/babylon-lite/src/post-process/smaa.js";

function createSource() {
    return createRenderTarget({
        lbl: "smaa-source",
        format: "rgba8unorm",
        samples: 1,
        size: { width: 64, height: 32 },
    });
}

function createEngine(): EngineContext {
    const device = {
        createTexture: vi.fn(
            () =>
                ({
                    createView: vi.fn(() => ({})),
                    destroy: vi.fn(),
                }) as unknown as GPUTexture
        ),
        createBuffer: vi.fn(() => ({ destroy: vi.fn() }) as unknown as GPUBuffer),
        createBindGroupLayout: vi.fn((descriptor) => descriptor as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor) => descriptor as GPUPipelineLayout),
        createShaderModule: vi.fn((descriptor) => descriptor as GPUShaderModule),
        createRenderPipeline: vi.fn((descriptor) => descriptor as GPURenderPipeline),
        createBindGroup: vi.fn((descriptor) => descriptor as GPUBindGroup),
        createSampler: vi.fn((descriptor) => descriptor as GPUSampler),
        queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    return { _device: device } as unknown as EngineContext;
}

describe("createSmaaPostProcessTask", () => {
    it("uses the documented defaults and creates diagnostic targets", () => {
        const source = createSource();
        const task = createSmaaPostProcessTask({ sourceTexture: source }, {} as EngineContext);

        expect(task.name).toBe("smaa");
        expect(task.sourceTexture).toBe(source);
        expect(task.sourceSamplingMode).toBe("linear");
        expect(task.threshold).toBe(0.05);
        expect(task.maxSearchSteps).toBe(16);
        expect(task.diagonalDetection).toBe(false);
        expect(task.minDiagonalRun).toBe(4);
        expect(task.cornerDetection).toBe(false);
        expect(task.dominantAxisBlend).toBe(true);
        expect(task.sourceIsSrgb).toBe(false);
        expect(task.edgesTexture._descriptor).toMatchObject({
            lbl: "smaa-edges",
            format: "rgba8unorm",
            samples: 1,
        });
        expect(task.weightsTexture._descriptor).toMatchObject({
            lbl: "smaa-weights",
            format: "rgba8unorm",
            samples: 1,
        });

        task.dispose();
    });

    it("sizes first-record intermediates from an unbuilt source descriptor", () => {
        const source = createSource();
        source._colorTexture = { createView: vi.fn(), destroy: vi.fn() } as unknown as GPUTexture;
        source._colorView = {} as GPUTextureView;
        const task = createSmaaPostProcessTask({ sourceTexture: source }, createEngine());

        task.record();

        expect(task.edgesTexture._width).toBe(64);
        expect(task.edgesTexture._height).toBe(32);
        expect(task.weightsTexture._width).toBe(64);
        expect(task.weightsTexture._height).toBe(32);
        task.dispose();
    });

    it("clamps numeric configuration and preserves valid mutations", () => {
        const task = createSmaaPostProcessTask(
            {
                name: "custom-smaa",
                sourceTexture: createSource(),
                threshold: 1,
                maxSearchSteps: 0,
                diagonalDetection: true,
                minDiagonalRun: 200,
                cornerDetection: true,
                dominantAxisBlend: false,
                sourceIsSrgb: true,
            },
            {} as EngineContext
        );

        expect(task.threshold).toBe(0.5);
        expect(task.maxSearchSteps).toBe(1);
        expect(task.minDiagonalRun).toBe(112);
        expect(task.diagonalDetection).toBe(true);
        expect(task.cornerDetection).toBe(true);
        expect(task.dominantAxisBlend).toBe(false);
        expect(task.sourceIsSrgb).toBe(true);

        task.threshold = 0.03;
        task.maxSearchSteps = 64.9;
        task.minDiagonalRun = 1;
        task.diagonalDetection = false;
        task.cornerDetection = false;
        task.dominantAxisBlend = true;
        task.sourceIsSrgb = false;

        expect(task.threshold).toBe(0.03);
        expect(task.maxSearchSteps).toBe(64);
        expect(task.minDiagonalRun).toBe(2);
        expect(task.diagonalDetection).toBe(false);
        expect(task.cornerDetection).toBe(false);
        expect(task.dominantAxisBlend).toBe(true);
        expect(task.sourceIsSrgb).toBe(false);

        task.threshold = Number.NaN;
        task.maxSearchSteps = Number.POSITIVE_INFINITY;
        task.minDiagonalRun = Number.NEGATIVE_INFINITY;

        expect(task.threshold).toBe(0.03);
        expect(task.maxSearchSteps).toBe(64);
        expect(task.minDiagonalRun).toBe(2);

        task.dispose();
    });
});
