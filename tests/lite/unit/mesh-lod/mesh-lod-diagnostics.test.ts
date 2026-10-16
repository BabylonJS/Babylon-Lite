import { describe, expect, it } from "vitest";
import { formatMeshLoDGpuTiming } from "../../../../lab/lite/src/demos/mesh-lod-diagnostics.js";
import type { RenderTaskGpuTimings } from "../../../../packages/babylon-lite/src/engine/gpu-task-timing.js";

describe("MeshLoD GPU timing", () => {
    it("reports the non-additive total for overlapping GPU tasks", () => {
        const timing: RenderTaskGpuTimings = {
            status: "available",
            supported: true,
            enabled: true,
            frameIndex: 1,
            tasks: [
                { index: 0, name: "scene", durationMs: 10 },
                { index: 1, name: "post-process", durationMs: 10 },
            ],
            totalDurationMs: 12.5,
            droppedTaskCount: 0,
        };
        expect(formatMeshLoDGpuTiming(timing)).toBe("12.50 ms");
        expect(formatMeshLoDGpuTiming({ ...timing, status: "pending", tasks: [], totalDurationMs: 0 })).toBe("pending…");
    });
});
