import type { SceneContext } from "../scene/scene-core.js";
import { getFrameGraph } from "../scene/scene-core.js";
import type { Task } from "./task.js";
import type { FrameGraph } from "./frame-graph.js";
import { _appendTask } from "./frame-graph.js";

function resolveFg(target: FrameGraph | SceneContext): FrameGraph {
    return "_tasks" in (target as object) ? (target as FrameGraph) : getFrameGraph(target as SceneContext);
}

/** Add a task at the END of execute order. Accepts the scene's frame graph directly,
 *  or a SceneContext (the scene's default frame graph is used). */
export function addTask(target: FrameGraph | SceneContext, task: Task): void {
    _appendTask(resolveFg(target), task);
}

/** Insert a task at the START of execute order. Accepts a FrameGraph or a SceneContext. */
export function addTaskAtStart(target: FrameGraph | SceneContext, task: Task): void {
    const fg = resolveFg(target);
    fg._tasks.unshift(task);
    fg._ready = false;
}

/** Insert a task BEFORE another task in execute order. Accepts a FrameGraph or a SceneContext. */
export function addTaskBefore(target: FrameGraph | SceneContext, task: Task, before: Task): void {
    const fg = resolveFg(target);
    const i = fg._tasks.indexOf(before);
    if (i < 0) {
        fg._tasks.push(task);
    } else {
        fg._tasks.splice(i, 0, task);
    }
    fg._ready = false;
}
