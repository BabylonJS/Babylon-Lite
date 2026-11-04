import type { EngineContext } from "./engine.js";

interface FramePostSubmitState {
    readonly hooks: Set<FramePostSubmitHook>;
    readonly dispatch: (encoder?: GPUCommandEncoder, submitted?: boolean) => void;
    lastDispatchedEncoder: GPUCommandEncoder | null;
}

interface FramePostSubmitHook {
    readonly run: (encoder: GPUCommandEncoder) => void;
    readonly cancel?: () => void;
    readonly encoder: GPUCommandEncoder | null;
}

type FramePostSubmitHookScope = "frame" | "persistent";

let _states: WeakMap<EngineContext, FramePostSubmitState> | null = null;

function releaseState(engine: EngineContext, state: FramePostSubmitState): void {
    if (state.hooks.size !== 0) {
        return;
    }
    if (engine._gpuTaskTimerResolve === state.dispatch) {
        engine._gpuTaskTimerResolve = undefined;
    }
    if (engine._gpuTimerResolve === state.dispatch) {
        engine._gpuTimerResolve = undefined;
    }
    if (_states?.get(engine) === state) {
        _states.delete(engine);
    }
}

/** @internal Register opt-in work that runs after a frame command buffer is submitted. */
export function addFramePostSubmitHook(engine: EngineContext, scope: FramePostSubmitHookScope, hook: (encoder: GPUCommandEncoder) => void, cancel?: () => void): () => void {
    const encoder = scope === "frame" ? engine._currentEncoder : null;
    if (scope === "frame" && !encoder) {
        throw new Error("Frame-bound post-submit work requires an active frame encoder.");
    }
    const states = (_states ??= new WeakMap());
    let state = states.get(engine);
    if (!state) {
        const hooks = new Set<FramePostSubmitHook>();
        const dispatch = (encoder = engine._currentEncoder, submitted = true) => {
            if (!encoder || state!.lastDispatchedEncoder === encoder) {
                return;
            }
            if (!submitted) {
                for (const current of hooks) {
                    if (current.encoder === encoder) {
                        hooks.delete(current);
                        current.cancel?.();
                    }
                }
                releaseState(engine, state!);
                return;
            }
            state!.lastDispatchedEncoder = encoder;
            for (const current of hooks) {
                if (current.encoder && current.encoder !== encoder) {
                    hooks.delete(current);
                    current.cancel?.();
                    continue;
                }
                if (current.encoder) {
                    hooks.delete(current);
                }
                current.run(encoder);
            }
            releaseState(engine, state!);
        };
        state = { hooks, dispatch, lastDispatchedEncoder: null };
        states.set(engine, state);
        const previousTaskResolver = engine._gpuTaskTimerResolve;
        engine._gpuTaskTimerResolve = dispatch;
        if (!engine._gpuTimerResolve || engine._gpuTimerResolve === previousTaskResolver) {
            engine._gpuTimerResolve = dispatch;
        }
    }
    const entry = { run: hook, cancel, encoder };
    state.hooks.add(entry);
    if (encoder) {
        queueMicrotask(() => {
            if (state!.hooks.has(entry) && engine._currentEncoder !== encoder) {
                state!.hooks.delete(entry);
                cancel?.();
                releaseState(engine, state!);
            }
        });
    }
    return () => {
        if (!state!.hooks.delete(entry)) {
            return;
        }
        releaseState(engine, state!);
    };
}
