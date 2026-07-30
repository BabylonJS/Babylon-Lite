import { onContextRestored } from "./context.js";
import type { GLEngineContext } from "./context.js";

interface AlphaToCoverageState {
    enabled: boolean;
    applied: boolean | null;
    restore: () => void;
}

// Optional feature state is allocated only after the first setter call. The weak key prevents this
// module from extending engine lifetime, and non-importing consumers allocate no feature state.
let _states: WeakMap<GLEngineContext, AlphaToCoverageState> | null = null;

/** Enable or disable WebGL2 sample alpha-to-coverage. Repeated state is elided. */
export function setAlphaToCoverage(engine: GLEngineContext, enabled: boolean): void {
    if (engine._disposed) {
        return;
    }
    const state = getOrCreateState(engine);
    state.enabled = enabled;
    applyState(engine, state);
}

/** Return the requested alpha-to-coverage state. Defaults to false. */
export function getAlphaToCoverage(engine: GLEngineContext): boolean {
    return _states?.get(engine)?.enabled ?? false;
}

/** Return the current draw framebuffer's sample count, normalized to at least one. */
export function getCurrentSampleCount(engine: GLEngineContext): number {
    if (engine._isLost || engine._disposed) {
        return 1;
    }
    const samples = Number(engine.gl.getParameter(engine.gl.SAMPLES));
    return Number.isFinite(samples) ? Math.max(1, samples) : 1;
}

function getOrCreateState(engine: GLEngineContext): AlphaToCoverageState {
    let states = _states;
    if (!states) {
        states = _states = new WeakMap();
    }
    let state = states.get(engine);
    if (state) {
        return state;
    }
    state = {
        enabled: false,
        applied: null,
        restore: () => {
            state!.applied = null;
            applyState(engine, state!);
        },
    };
    states.set(engine, state);
    (engine._stateCacheInvalidators ??= []).push(() => {
        state!.applied = null;
    });
    onContextRestored(engine, state.restore);
    return state;
}

function applyState(engine: GLEngineContext, state: AlphaToCoverageState): void {
    if (engine._isLost || engine._disposed || state.applied === state.enabled) {
        return;
    }
    const gl = engine.gl;
    if (state.enabled) {
        gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    } else {
        gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    }
    state.applied = state.enabled;
}
