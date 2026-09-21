import type { EngineContext } from "./engine.js";

interface FramePostSubmitState {
    readonly hooks: Set<FramePostSubmitHook>;
    readonly dispatch: (encoder?: GPUCommandEncoder) => void;
    readonly cancel: (encoder: GPUCommandEncoder) => void;
    lastDispatchedEncoder: GPUCommandEncoder | null;
}

interface FramePostSubmitHook {
    readonly run: () => void;
    readonly cancel?: () => void;
    readonly encoder: GPUCommandEncoder | null;
}

let _states: WeakMap<EngineContext, FramePostSubmitState> | null = null;

function releaseState(engine: EngineContext, state: FramePostSubmitState): void {
    if (state.hooks.size !== 0) {
        return;
    }
    if (engine._gpuTaskTimerResolve === state.dispatch) {
        engine._gpuTaskTimerResolve = undefined;
    }
    if (!engine._gpuTimerWanted && engine._gpuTimerResolve === state.dispatch) {
        engine._gpuTimerResolve = undefined;
    }
    if (engine._framePostSubmit === state.dispatch) {
        engine._framePostSubmit = undefined;
    }
    if (engine._framePostSubmitCancel === state.cancel) {
        engine._framePostSubmitCancel = undefined;
    }
    _states?.delete(engine);
}

/** @internal Register opt-in work that runs after the main frame command buffer is submitted. */
export function addFramePostSubmitHook(engine: EngineContext, hook: () => void, cancel?: () => void): () => void {
    const states = (_states ??= new WeakMap());
    let state = states.get(engine);
    if (!state) {
        const hooks = new Set<FramePostSubmitHook>();
        const dispatch = (encoder = engine._currentEncoder) => {
            if (!encoder || state!.lastDispatchedEncoder === encoder) {
                return;
            }
            state!.lastDispatchedEncoder = encoder;
            for (const current of hooks) {
                if (current.encoder && current.encoder !== encoder) {
                    continue;
                }
                if (current.encoder) {
                    hooks.delete(current);
                }
                current.run();
            }
            releaseState(engine, state!);
        };
        const cancelFrame = (encoder: GPUCommandEncoder) => {
            for (const current of hooks) {
                if (current.encoder !== encoder) {
                    continue;
                }
                hooks.delete(current);
                current.cancel?.();
            }
            releaseState(engine, state!);
        };
        state = { hooks, dispatch, cancel: cancelFrame, lastDispatchedEncoder: null };
        states.set(engine, state);
        engine._gpuTaskTimerResolve = dispatch;
        engine._gpuTimerResolve ??= dispatch;
        engine._framePostSubmit = dispatch;
        engine._framePostSubmitCancel = cancelFrame;
    }
    const entry = { run: hook, cancel, encoder: engine._currentEncoder ?? null };
    state.hooks.add(entry);
    return () => {
        if (!state!.hooks.delete(entry)) {
            return;
        }
        releaseState(engine, state!);
    };
}
