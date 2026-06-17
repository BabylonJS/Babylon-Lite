import type { EngineContext } from "./engine.js";

/** Availability / lifecycle state for per-frame-graph-task GPU timings. */
export type RenderTaskGpuTimingStatus = "unsupported" | "disabled" | "pending" | "available" | "error";

/** GPU time measured for one frame-graph task in one rendered frame. */
export interface RenderTaskGpuTiming {
    /** Execution-order index within the measured frame. Useful when several tasks share the same name. */
    readonly index: number;
    /** The task's existing frame-graph label (`Task.name`, e.g. `"shadow"`, `"scene"`, `"post-process"`). */
    readonly name: string;
    /** GPU duration for this task in milliseconds. */
    readonly durationMs: number;
}

/** Latest per-task GPU timing snapshot for an engine. */
export interface RenderTaskGpuTimings {
    /** `unsupported` when the WebGPU device lacks `timestamp-query`; `pending` until the first readback lands. */
    readonly status: RenderTaskGpuTimingStatus;
    /** Whether this engine's device exposes WebGPU timestamp queries. */
    readonly supported: boolean;
    /** Whether task timing is currently enabled and recording future frames. */
    readonly enabled: boolean;
    /** Monotonic profiler frame index for the snapshot. `0` means no measured frame has completed yet. */
    readonly frameIndex: number;
    /** Measured tasks in frame execution order. Empty until `status === "available"`. */
    readonly tasks: readonly RenderTaskGpuTiming[];
    /** Number of tasks skipped in that frame because the profiler's query-set capacity was exceeded. */
    readonly droppedTaskCount: number;
    /** Readback failure message when `status === "error"`. */
    readonly error?: string;
}

/** Whether per-render-task GPU timing can run on this engine's WebGPU device. */
export function isRenderTaskGpuTimingSupported(engine: EngineContext): boolean {
    return engine._device.features.has("timestamp-query");
}

/** Return the latest task GPU timing snapshot without stalling the GPU or CPU. */
export function getRenderTaskGpuTimings(engine: EngineContext): RenderTaskGpuTimings {
    if (!isRenderTaskGpuTimingSupported(engine)) {
        return makeTimingSnapshot("unsupported", false, false, 0, [], 0);
    }
    const snapshot = engine._gpuTaskTimingResult;
    if (snapshot) {
        return snapshot;
    }
    if (engine._gpuTaskTimerWanted) {
        return makeTimingSnapshot("pending", true, true, 0, [], 0);
    }
    return makeTimingSnapshot("disabled", true, false, 0, [], 0);
}

/** Enable or disable per-frame-graph-task GPU timing.
 *
 * The profiling implementation is loaded with a dynamic import on first enable. Engines that never call this
 * function do not fetch the profiler chunk or carry task-timing code in the always-fetched frame graph.
 * The returned snapshot is `unsupported` if the device lacks WebGPU `timestamp-query`, `pending` immediately
 * after enable, and `available` once a later frame's async timestamp readback completes.
 */
export async function setRenderTaskGpuTimingEnabled(engine: EngineContext, enabled: boolean): Promise<RenderTaskGpuTimings> {
    if (!enabled) {
        engine._gpuTaskTimerEpoch = (engine._gpuTaskTimerEpoch ?? 0) + 1;
        engine._gpuTaskTimerWanted = false;
        engine._gpuTaskTimerDisable?.();
        engine._gpuTaskTimerDisable = undefined;
        const supported = isRenderTaskGpuTimingSupported(engine);
        engine._gpuTaskTimingResult = makeTimingSnapshot(supported ? "disabled" : "unsupported", supported, false, 0, [], 0);
        return engine._gpuTaskTimingResult;
    }

    if (!isRenderTaskGpuTimingSupported(engine)) {
        engine._gpuTaskTimerWanted = false;
        engine._gpuTaskTimingResult = makeTimingSnapshot("unsupported", false, false, 0, [], 0);
        return engine._gpuTaskTimingResult;
    }

    if (engine._gpuTaskTimerWanted) {
        return getRenderTaskGpuTimings(engine);
    }

    const epoch = (engine._gpuTaskTimerEpoch ?? 0) + 1;
    engine._gpuTaskTimerEpoch = epoch;
    engine._gpuTaskTimerWanted = true;
    engine._gpuTaskTimingResult = makeTimingSnapshot("pending", true, true, 0, [], 0);
    const { createGpuTaskTimer, installGpuTaskTimer } = await import("./gpu-task-timer.js");
    if (!engine._gpuTaskTimerWanted || engine._gpuTaskTimerEpoch !== epoch) {
        return getRenderTaskGpuTimings(engine);
    }

    if (engine._gpuTaskTimer === undefined) {
        engine._gpuTaskTimer = createGpuTaskTimer(engine._device);
    }
    const timer = engine._gpuTaskTimer;
    if (!timer) {
        engine._gpuTaskTimerWanted = false;
        engine._gpuTaskTimingResult = makeTimingSnapshot("unsupported", false, false, 0, [], 0);
        return engine._gpuTaskTimingResult;
    }

    engine._gpuTaskTimerDisable = installGpuTaskTimer(timer, engine, (snapshot) => {
        if (engine._gpuTaskTimerWanted && engine._gpuTaskTimerEpoch === epoch) {
            engine._gpuTaskTimingResult = snapshot;
        }
    });
    return getRenderTaskGpuTimings(engine);
}

/** @internal */
export function makeTimingSnapshot(
    status: RenderTaskGpuTimingStatus,
    supported: boolean,
    enabled: boolean,
    frameIndex: number,
    tasks: readonly RenderTaskGpuTiming[],
    droppedTaskCount: number,
    error?: string
): RenderTaskGpuTimings {
    return { status, supported, enabled, frameIndex, tasks, droppedTaskCount, error };
}
