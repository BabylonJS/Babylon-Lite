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
 *   3. await fg.build()                     → record every task
 *      (allocate render-target textures, build pass descriptors)
 *   4. fg.execute()                         → drain every task into the
 *      current command encoder (called from scene._record)
 *   5. fg.dispose()                         → free everything
 */

import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import type { SceneContextInternal } from "../scene/scene-core.js";
import type { Task } from "./task.js";

/** The frame graph — an ordered list of tasks. */
export interface FrameGraph {
    /** Ordered list of tasks. Executed in array order each frame. */
    _tasks: Task[];
    /** True after `build()` succeeds. */
    _ready: boolean;
    /** Engine and scene captured at creation. */
    _engine: EngineContextInternal;
    _scene: SceneContextInternal;

    /** Build (or rebuild) every task in execute order. */
    build(): Promise<void>;

    /** Execute every task. Each task reads the current encoder via
     *  `engine._currentEncoder`. Returns total draw calls.
     *  No-op (returns 0) if the graph hasn't been built yet. */
    execute(): number;

    /** Free all GPU resources owned by the frame graph. */
    dispose(): void;
}

/** Create an empty frame graph bound to the given engine and scene. */
export function createFrameGraph(engine: EngineContext, scene: SceneContextInternal): FrameGraph {
    const eng = engine as EngineContextInternal;
    const fg: FrameGraph = {
        _tasks: [],
        _ready: false,
        _engine: eng,
        _scene: scene,

        async build(): Promise<void> {
            for (let i = 0; i < fg._tasks.length; i++) {
                await fg._tasks[i]!.record();
            }
            fg._ready = true;
        },

        execute(): number {
            if (!fg._ready) {
                return 0;
            }
            let drawCalls = 0;
            for (const task of fg._tasks) {
                drawCalls += task.execute();
            }
            return drawCalls;
        },

        dispose(): void {
            for (const task of fg._tasks) {
                task.dispose();
            }
            fg._tasks.length = 0;
            fg._ready = false;
        },
    };
    return fg;
}

/** Add a task at the END of execute order. */
export function _appendTask(fg: FrameGraph, task: Task): void {
    fg._tasks.push(task);
    fg._ready = false;
}
