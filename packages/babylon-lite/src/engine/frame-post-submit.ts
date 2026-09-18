import type { EngineContext } from "./engine.js";

interface FramePostSubmitState {
    readonly hooks: Set<() => void>;
    readonly dispatch: () => void;
}

let _states: WeakMap<EngineContext, FramePostSubmitState> | null = null;

/** @internal Register opt-in work that runs after the main frame command buffer is submitted. */
export function addFramePostSubmitHook(engine: EngineContext, hook: () => void): () => void {
    const states = (_states ??= new WeakMap());
    let state = states.get(engine);
    if (!state) {
        const hooks = new Set<() => void>();
        const dispatch = () => {
            for (const current of hooks) {
                current();
            }
        };
        state = { hooks, dispatch };
        states.set(engine, state);
        engine._gpuTaskTimerResolve = dispatch;
        engine._gpuTimerResolve ??= dispatch;
    }
    state.hooks.add(hook);
    return () => {
        if (!state!.hooks.delete(hook) || state!.hooks.size !== 0) {
            return;
        }
        if (engine._gpuTaskTimerResolve === state!.dispatch) {
            engine._gpuTaskTimerResolve = undefined;
        }
        if (!engine._gpuTimerWanted && engine._gpuTimerResolve === state!.dispatch) {
            engine._gpuTimerResolve = undefined;
        }
        states.delete(engine);
    };
}
