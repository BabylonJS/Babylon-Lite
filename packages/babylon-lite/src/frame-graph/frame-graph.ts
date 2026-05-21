/**
 * FrameGraph — orchestrates a scene's per-frame GPU work as an ordered list
 * of tasks. There is no privileged "main" task: a scene-render task that
 * draws into the swapchain is just one task among many. Pre-pass RTTs run
 * first, the scene-render task draws into the swapchain, UI overlay tasks
 * run after, etc. Order is the user's responsibility (controlled via
 * `addTask`, `addTaskAtStart`, and `addTaskBefore`).
 *
 * Lifecycle:
 *   1. createFrameGraph(engine, scene)      → empty graph
 *   2. addTask{,AtStart,Before}             → register tasks
 *      (createSceneContext registers a default scene-render task)
 *   3. fg.build()                           → record every task
 *      (allocate render-target textures, build pass descriptors)
 *   4. fg.execute()                         → drain every task into the
 *      current command encoder (called from scene._record)
 *   5. fg.dispose()                         → free everything
 */

import type { EngineContext } from "../engine/engine.js";
import type { SceneContextInternal } from "../scene/scene-core.js";
import type { Task } from "./task.js";

/** The frame graph — an ordered list of tasks. */
export interface FrameGraph {
    /** Ordered list of tasks. Executed in array order each frame. */
    _tasks: Task[];

    /** Set during `build()` while a single task's `record()` is running.
     *  Used by `addRenderPass` to associate a
     *  freshly-created pass with the task that is currently recording.
     *  Mirrors BJS' implicit "currentProcessedTask" in `frameGraph.buildAsync`. */
    _currentProcessedTask: Task | null;

    /** Build (or rebuild) every task in execute order. */
    build(): void;

    /** Execute every task's recorded passes. Returns total draw calls. */
    execute(): number;

    /** Free all GPU resources owned by the frame graph. */
    dispose(): void;
}

/** Create an empty frame graph bound to the given engine and scene. */
export function createFrameGraph(_engine: EngineContext, _scene: SceneContextInternal): FrameGraph {
    const fg: FrameGraph = {
        _tasks: [],
        _currentProcessedTask: null,

        build(): void {
            // Phase 1 — record. Each task creates its passes; `createRenderPass`
            // appends each new pass to the currently-recording task's `_passes` list.
            for (let i = 0; i < fg._tasks.length; i++) {
                const task = fg._tasks[i]!;
                task._passes.length = 0;
                fg._currentProcessedTask = task;
                task.record();
                fg._currentProcessedTask = null;
            }
            // Phase 2 — initialize. Runs after every task has finished recording
            // so passes can safely reference resources allocated by other tasks
            // (e.g. RTTs whose textures are wired up by a later task's `record`).
            for (let i = 0; i < fg._tasks.length; i++) {
                const passes = fg._tasks[i]!._passes;
                for (let j = 0; j < passes.length; j++) {
                    passes[j]!._initialize();
                }
            }
        },

        execute(): number {
            let drawCalls = 0;
            for (const task of fg._tasks) {
                if (task.execute) {
                    drawCalls += task.execute();
                } else {
                    for (const pass of task._passes) {
                        drawCalls += pass._execute();
                    }
                }
            }
            return drawCalls;
        },

        dispose(): void {
            for (const task of fg._tasks) {
                task.dispose();
            }
            fg._tasks.length = 0;
            fg._currentProcessedTask = null;
        },
    };
    return fg;
}

/** Add a task at the END of execute order. */
export function _appendTask(fg: FrameGraph, task: Task): void {
    fg._tasks.push(task);
}
