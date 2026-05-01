/**
 * Task — the polymorphic interface that all frame-graph tasks must implement.
 *
 * Modelled on Babylon.js' `FrameGraphTask`, pared down for Babylon-Lite:
 *   - We do NOT (yet) split a task into multiple sub-passes; each task owns
 *     and executes its own GPU work directly.
 *   - The interface uses methods so the frame graph can dispatch
 *     polymorphically — same pattern as `Renderable.draw`.
 *
 * Lifecycle:
 *   - Engine and scene are captured at task creation and exposed as
 *     `engine` / `scene`.
 *   - `record()` is called when the frame graph is built (via
 *     `FrameGraph.build()`). Tasks use this to allocate GPU resources, build
 *     their render-pass descriptor, and finalize anything that needs the
 *     final canvas / target size.
 *   - `execute()` is called once per frame and reads the current encoder from
 *     `engine._currentEncoder`. It returns the number of draw calls issued.
 *   - `dispose()` is called when the frame graph is disposed.
 */

import type { EngineContextInternal } from "../engine/engine.js";
import type { SceneContextInternal } from "../scene/scene-core.js";

export interface Task {
    readonly name: string;

    /** Engine and scene captured at task creation. */
    readonly engine: EngineContextInternal;
    readonly scene: SceneContextInternal;

    /** Called once when the frame graph is built. May be async. */
    record(): Promise<void> | void;

    /** Called once per frame. Reads the current encoder via `engine._currentEncoder`.
     *  Returns the number of GPU draw calls issued. */
    execute(): number;

    /** Free all GPU resources owned by this task. */
    dispose(): void;
}
