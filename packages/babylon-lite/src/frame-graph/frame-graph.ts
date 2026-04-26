/**
 * FrameGraph — orchestrates rendering through an ordered list of tasks.
 *
 * Lifecycle:
 *   1. createFrameGraph(engine, scene)  → empty graph, engine + scene captured
 *   2. add render pass tasks
 *   3. fg.build()                        → record every task (allocate RTs, bind renderables).
 *                                           Idempotent: also called on canvas resize to reallocate
 *                                           RT textures. Scene-level builders (mesh-group batch
 *                                           builds, env background, addToPass) are drained by the
 *                                           engine in `renderFrame` BEFORE this is called, so by
 *                                           the time tasks record, scene._renderables is final.
 *   4. fg.execute()                      → called each frame to encode + submit GPU work
 *   5. fg.dispose()                      → free everything
 */

import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import type { SceneContextInternal } from "../scene/scene-core.js";
import type { RenderPassTask } from "./render-pass-task.js";
import type { Task } from "./task.js";

/** The frame graph — an ordered list of tasks. Today only RenderPassTask exists,
 *  but every task is dispatched polymorphically via the `Task` interface (record/execute/dispose). */
export interface FrameGraph {
    /** Ordered list of tasks. */
    _tasks: Task[];
    /** True after build() succeeds. */
    _ready: boolean;
    /** Engine and scene captured at creation. */
    _engine: EngineContextInternal;
    _scene: SceneContextInternal;

    /**
     * Build (or rebuild) the frame graph by recording every task in execute order.
     *
     * Called both for the initial build AND for canvas resize: `task.record()` re-runs
     * `buildRenderTarget` which reallocates non-eager RT textures at the new size.
     */
    build(): Promise<void>;

    /** Execute the frame graph for one frame: single command encoder, all tasks, submit. */
    execute(): void;

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

        execute(): void {
            if (!fg._ready) {
                return;
            }

            const sc = fg._scene;
            let drawCalls = 0;
            const encoder = eng.device.createCommandEncoder();

            // Pre-passes (shadow maps etc.) — still using old path for now
            for (const light of sc.lights) {
                const sg = light.shadowGenerator;
                if (sg) {
                    drawCalls += sg.renderShadowMap(encoder);
                }
            }
            for (const pp of sc._prePasses) {
                drawCalls += pp.execute(encoder, eng);
            }

            // Execute all tasks in order via the polymorphic Task interface.
            // The current swapchain view is exposed on `eng._swapChainView` (acquired by the engine RAF).
            for (const task of fg._tasks) {
                drawCalls += task.execute(encoder);
            }

            eng.device.queue.submit([encoder.finish()]);
            eng.drawCallCount = drawCalls;
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

/** Add a render pass task to the frame graph (appended to the end of execute order). */
export function addRenderPassTask(fg: FrameGraph, task: RenderPassTask): void {
    fg._tasks.push(task);
}

/** Insert a render pass task at the START of execute order. Useful for RTT passes
 *  whose output feeds into the main pass (which is always the last task). */
export function addRenderPassTaskAtStart(fg: FrameGraph, task: RenderPassTask): void {
    fg._tasks.unshift(task);
}

/** Insert a render pass task BEFORE another task in execute order. */
export function addRenderPassTaskBefore(fg: FrameGraph, task: RenderPassTask, before: RenderPassTask): void {
    const i = fg._tasks.indexOf(before);
    if (i < 0) {
        fg._tasks.push(task);
    } else {
        fg._tasks.splice(i, 0, task);
    }
}
