import type { Pass } from "./pass.js";
import type { Task } from "./task.js";

/** @internal Record texture work whose preparation must run after all target allocations. */
export function createTextureTaskPass(task: Task, initialize: () => void, execute: () => number, dispose: () => void): Pass {
    const pass: Pass = {
        name: task.name,
        _parentTask: task,
        _dependencies: new Set(),
        _executeFunc: null,
        _beforeExecute: null,
        _initialize: initialize,
        _execute(): number {
            pass._beforeExecute?.();
            return execute();
        },
        _dispose(): void {
            dispose();
            pass._dependencies.clear();
            pass._executeFunc = null;
            pass._beforeExecute = null;
        },
    };
    task._passes.push(pass);
    return pass;
}
