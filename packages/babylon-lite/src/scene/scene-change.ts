import { _setSceneChangeHook } from "./scene-core.js";
import type { SceneChangeEvent, SceneChangeListener, SceneContext } from "./scene-core.js";

/** @internal Lazily allocated state for generic scene-change subscribers. */
export interface SceneChangeState {
    listeners: Set<SceneChangeListener>;
    pending: SceneChangeEvent[];
    depth: number;
    dispatching: boolean;
}

let installed = false;

function throwFailures(failures: unknown[]): void {
    if (failures.length === 1) {
        throw failures[0];
    }
    if (failures.length > 1) {
        throw new AggregateError(failures);
    }
}

function runSceneChange(scene: SceneContext, mutation: () => void): void {
    const state = scene._sceneChanges;
    if (!state) {
        mutation();
        return;
    }
    state.depth++;
    let failed = false;
    let failure: unknown;
    try {
        mutation();
    } catch (error) {
        failed = true;
        failure = error;
    }
    state.depth--;
    if (state.depth > 0 || state.dispatching) {
        if (failed) {
            throw failure;
        }
        return;
    }

    const failures = failed ? [failure] : [];
    state.dispatching = true;
    try {
        while (state.pending.length) {
            const event = state.pending.shift()!;
            for (const listener of [...state.listeners]) {
                if (!state.listeners.has(listener)) {
                    continue;
                }
                try {
                    listener(event);
                } catch (error) {
                    failures.push(error);
                }
            }
        }
    } finally {
        state.dispatching = false;
        if (!state.listeners.size) {
            scene._sceneChanges = undefined;
        }
    }
    throwFailures(failures);
}

function install(): void {
    if (installed) {
        return;
    }
    installed = true;
    _setSceneChangeHook({
        run: runSceneChange,
        record: (scene, entity, type) => scene._sceneChanges?.pending.push({ type, entity }),
        dispose: (scene, cleanup) => {
            const failures: unknown[] = [];
            for (const callback of scene._disposables.splice(0)) {
                try {
                    callback();
                } catch (error) {
                    failures.push(error);
                }
            }
            scene._disposables.length = 0;
            try {
                cleanup();
            } catch (error) {
                failures.push(error);
            } finally {
                scene._sceneChanges = undefined;
            }
            throwFailures(failures);
        },
    });
}

/** Subscribe to committed scene-membership changes.
 *
 * Recursive add/remove operations publish after the outermost mutation completes. Listener
 * failures do not prevent later listeners or reentrant changes from running. The returned
 * callback removes only this registration and is idempotent. */
export function onSceneChange(scene: SceneContext, listener: SceneChangeListener): () => void {
    if (scene._z) {
        throw new Error("Cannot observe a disposed scene.");
    }
    install();
    const state = (scene._sceneChanges ??= {
        listeners: new Set(),
        pending: [],
        depth: 0,
        dispatching: false,
    });
    const subscribed = (event: SceneChangeEvent): void => listener(event);
    state.listeners.add(subscribed);
    let active = true;
    return () => {
        if (!active) {
            return;
        }
        active = false;
        state.listeners.delete(subscribed);
        if (!state.listeners.size && !state.depth && !state.dispatching) {
            scene._sceneChanges = undefined;
        }
    };
}

/** Register a callback to run when `disposeScene` is called. Used to tie
 *  user-owned resources to the scene's lifetime. The returned callback removes
 *  only this registration and is idempotent. */
export function onSceneDispose(scene: SceneContext, callback: () => void): () => void {
    install();
    const disposables = scene._disposables;
    disposables.push(callback);
    let active = true;
    return () => {
        if (!active) {
            return;
        }
        active = false;
        const index = disposables.indexOf(callback);
        if (index >= 0) {
            disposables.splice(index, 1);
        }
    };
}
