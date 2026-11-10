/**
 * GPU frame timing — the Babylon Native backend of `src/gpu-frame-time.ts`.
 *
 * Babylon Native has no timer queries; instead the host exposes
 * `_native.Engine#populateFrameStats(stats)`, which reports the GPU time of the
 * last completed bgfx frame (`gpuTimeNs`). While capture is enabled, each
 * `endFrame` (called automatically by `runRenderLoop`) samples it into the
 * counter. When the host lacks `populateFrameStats` (`caps.gpuFrameTime` is
 * `false`) capture is a silent no-op and the counter's `count` stays 0 — the same
 * contract as WebGL without `EXT_disjoint_timer_query_webgl2`.
 */
import type { GLEngineContext } from "./native-context.js";
import type { GLPerfCounter } from "../gpu-frame-time.js";
import type { NativeFrameStats } from "./native-types.js";

export type { GLPerfCounter } from "../gpu-frame-time.js";

/**
 * Returns the GPU frame-time counter for `engine` (Babylon
 * `engine.getGPUFrameTimeCounter()`), creating it on first use. Values are in
 * nanoseconds; the counter is only fed while `captureGPUFrameTime(engine, true)`
 * is active on a host that exposes `populateFrameStats`.
 *
 * @param engine - The engine.
 * @returns The (live) counter.
 */
export function getGPUFrameTimeCounter(engine: GLEngineContext): GLPerfCounter {
    let counter = engine._gpuFrameTime;
    if (counter === undefined) {
        counter = { current: 0, average: 0, lastSecAverage: 0, min: 0, max: 0, total: 0, count: 0, _lastSecTotal: 0, _lastSecCount: 0, _lastSecTime: 0 };
        engine._gpuFrameTime = counter;
    }
    return counter;
}

/**
 * Enables or disables GPU frame-time measurement (Babylon
 * `engine.captureGPUFrameTime(value)`). While enabled, every `endFrame` samples
 * the host's last-frame GPU time (`populateFrameStats().gpuTimeNs`) into
 * {@link getGPUFrameTimeCounter}. Non-finite or non-positive samples (no frame
 * submitted yet) are discarded. Silently samples nothing when the host has no
 * `populateFrameStats` (`caps.gpuFrameTime === false`).
 *
 * @param engine - The engine.
 * @param enabled - `true` to start measuring, `false` to stop.
 */
export function captureGPUFrameTime(engine: GLEngineContext, enabled: boolean): void {
    const hooks = engine._frameHooks;
    if (!enabled) {
        if (hooks !== undefined) {
            hooks._dispose();
            engine._frameHooks = undefined;
        }
        return;
    }
    if (hooks !== undefined || engine._disposed) {
        return;
    }
    const counter = getGPUFrameTimeCounter(engine);
    const stats: NativeFrameStats = { gpuTimeNs: 0 };
    engine._frameHooks = {
        _begin: () => {},
        _end: () => {
            const native = engine._engine;
            if (engine._isLost || engine._disposed || typeof native.populateFrameStats !== "function") {
                return;
            }
            stats.gpuTimeNs = 0;
            native.populateFrameStats(stats);
            const value = stats.gpuTimeNs;
            if (isFinite(value) && value > 0) {
                addSample(counter, value);
            }
        },
        _dispose: () => {},
    };
}

/** Babylon `PerfCounter.fetchNewFrame()` + `addCount(value, true)`. */
function addSample(counter: GLPerfCounter, value: number): void {
    counter.count++;
    counter.current = value;
    counter.total += value;
    if (counter.count === 1) {
        counter.min = value;
        counter.max = value;
    } else {
        counter.min = Math.min(counter.min, value);
        counter.max = Math.max(counter.max, value);
    }
    counter.average = counter.total / counter.count;
    counter._lastSecTotal += value;
    counter._lastSecCount++;
    const now = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
    if (now - counter._lastSecTime > 1000) {
        counter.lastSecAverage = counter._lastSecTotal / counter._lastSecCount;
        counter._lastSecTime = now;
        counter._lastSecTotal = 0;
        counter._lastSecCount = 0;
    }
}
