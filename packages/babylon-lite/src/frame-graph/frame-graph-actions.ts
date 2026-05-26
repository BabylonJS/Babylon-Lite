import type { SceneContext } from "../scene/scene-core.js";
import { getFrameGraph } from "../scene/scene-core.js";
import type { Task } from "./task.js";
import type { FrameGraph } from "./frame-graph.js";
import { _appendTask } from "./frame-graph.js";
import type { RenderPass } from "./render-pass.js";
import { createRenderPass } from "./render-pass.js";

function resolveFg(target: FrameGraph | SceneContext): FrameGraph {
    return "_tasks" in (target as object) ? (target as FrameGraph) : getFrameGraph(target as SceneContext);
}

/** Add a task at the END of execute order. Accepts the scene's frame graph directly,
 *  or a SceneContext (the scene's default frame graph is used). */
export function addTask(target: FrameGraph | SceneContext, task: Task): void {
    _appendTask(resolveFg(target), task);
}

/** Insert a task at the START of user execute order. Built-in system tasks that must
 *  precede all user work, such as the shadow adapter, keep their leading slot. */
export function addTaskAtStart(target: FrameGraph | SceneContext, task: Task): void {
    const fg = resolveFg(target);
    const firstUserTask = fg._tasks[0]?.name === "shadow" ? 1 : 0;
    fg._tasks.splice(firstUserTask, 0, task);
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
}

/** Create a `RenderPass`, wire it to the task currently recording, and return
 *  it. Must be called from inside `Task.record()` so the FG can associate the
 *  new pass with the right task (mirrors BJS `frameGraph.addRenderPass`).
 *
 *  Configure the returned pass with `setRenderPassRenderTarget`,
 *  `setRenderPassExecuteFunc`, etc. before the FG finishes building. */
export function addRenderPass(target: FrameGraph | SceneContext, name: string): RenderPass {
    const fg = resolveFg(target);
    const task = fg._currentProcessedTask;
    if (!task) {
        throw new Error(`addRenderPass("${name}"): no task is currently recording (called outside Task.record?)`);
    }
    return createRenderPass(name, task);
}
