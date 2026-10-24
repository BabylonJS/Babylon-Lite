import type { GLEngineContext } from "./context.js";

/**
 * Running statistics over a stream of samples — the data subset of Babylon's
 * `PerfCounter`. For the GPU frame-time counter every value is in
 * **nanoseconds** (as in Babylon); divide by `1e6` for milliseconds.
 *
 * All fields are read-only for callers; the owning feature updates them.
 */
export interface GLPerfCounter {
    /** Most recent sample. */
    current: number;
    /** Mean of every sample since the counter was created. */
    average: number;
    /** Mean of the samples gathered during the last completed ~1 second window. */
    lastSecAverage: number;
    /** Smallest sample seen (0 until the first sample). */
    min: number;
    /** Largest sample seen (0 until the first sample). */
    max: number;
    /** Sum of every sample. */
    total: number;
    /** Number of samples. */
    count: number;
    /** @internal */
    _lastSecTotal: number;
    /** @internal */
    _lastSecCount: number;
    /** @internal */
    _lastSecTime: number;
}

/** Subset of `EXT_disjoint_timer_query_webgl2` used here. */
interface GLTimerQueryExtension {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
}

/**
 * Returns the GPU frame-time counter for `engine` (Babylon
 * `engine.getGPUFrameTimeCounter()`), creating it on first use. The counter is
 * only fed while `captureGPUFrameTime(engine, true)` is active and the
 * `EXT_disjoint_timer_query_webgl2` extension is available; otherwise `count`
 * stays at 0. Values are in nanoseconds.
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
 * `engine.captureGPUFrameTime(value)`). While enabled, each frame delimited by
 * `beginFrame` / `endFrame` — which `runRenderLoop` calls automatically — is
 * wrapped in a `TIME_ELAPSED_EXT` timer query. Results arrive asynchronously a
 * few frames later and feed `getGPUFrameTimeCounter(engine)`. Only one query is
 * in flight at a time, so not every frame is sampled.
 *
 * Silently does nothing useful when `EXT_disjoint_timer_query_webgl2` is
 * unavailable (common outside desktop Chrome, and often disabled for privacy).
 * Samples overlapping a disjoint GPU event are discarded. Survives context
 * loss: the in-flight query is dropped and measurement resumes after restore.
 *
 * @param engine - The lite-gl engine.
 * @param enabled - `true` to start measuring, `false` to stop and release the pending query.
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
    const gl = engine.gl;
    const counter = getGPUFrameTimeCounter(engine);
    // `undefined` = not queried yet (or invalidated by context loss); `null` = unsupported.
    let ext: GLTimerQueryExtension | null | undefined;
    let query: WebGLQuery | null = null;
    let ended = false;
    // Query handles and extension objects die with the context.
    const onLost = (): void => {
        query = null;
        ext = undefined;
    };
    engine._onLost.push(onLost);
    engine._frameHooks = {
        _begin: () => {
            if (query !== null || engine._isLost || engine._disposed) {
                return;
            }
            if (ext === undefined) {
                ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as GLTimerQueryExtension | null;
            }
            if (ext === null) {
                return;
            }
            query = gl.createQuery();
            if (query !== null) {
                gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
                ended = false;
            }
        },
        _end: () => {
            if (query === null || ext === null || ext === undefined || engine._isLost || engine._disposed) {
                return;
            }
            if (!ended) {
                gl.endQuery(ext.TIME_ELAPSED_EXT);
                ended = true;
            }
            if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
                return;
            }
            // Reading GPU_DISJOINT_EXT also clears it; a disjoint result is unreliable.
            if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
                addSample(counter, gl.getQueryParameter(query, gl.QUERY_RESULT) as number);
            }
            gl.deleteQuery(query);
            query = null;
        },
        _dispose: () => {
            const i = engine._onLost.indexOf(onLost);
            if (i !== -1) {
                engine._onLost.splice(i, 1);
            }
            if (query !== null && !engine._isLost) {
                if (!ended && ext) {
                    gl.endQuery(ext.TIME_ELAPSED_EXT);
                }
                gl.deleteQuery(query);
            }
            query = null;
        },
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
    const now = performance.now();
    if (now - counter._lastSecTime > 1000) {
        counter.lastSecAverage = counter._lastSecTotal / counter._lastSecCount;
        counter._lastSecTime = now;
        counter._lastSecTotal = 0;
        counter._lastSecCount = 0;
    }
}
