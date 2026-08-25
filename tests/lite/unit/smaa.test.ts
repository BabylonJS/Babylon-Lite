import { describe, expect, it } from "vitest";
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
