// Leaf module shared by gpu-task-timing.ts and the gpu-task-timer.ts runtime it lazy-loads;
// the lazy module must not statically import its loader (tests/lite/build/lazy-import-cycles.test.ts).

import type { RenderTaskGpuTiming, RenderTaskGpuTimings, RenderTaskGpuTimingStatus } from "./gpu-task-timing.js";

/** @internal */
export function makeTimingSnapshot(
    status: RenderTaskGpuTimingStatus,
    supported: boolean,
    enabled: boolean,
    frameIndex: number,
    tasks: readonly RenderTaskGpuTiming[],
    droppedTaskCount: number,
    totalDurationMs: number,
    error?: string
): RenderTaskGpuTimings {
    return { status, supported, enabled, frameIndex, tasks, totalDurationMs, droppedTaskCount, error };
}
