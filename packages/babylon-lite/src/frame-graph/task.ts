/**
 * Task — the polymorphic interface that all frame-graph tasks must implement.
 *
 * Modelled on Babylon.js' `FrameGraphTask`, pared down for Babylon-Lite:
 *   - The interface uses methods so the frame graph can dispatch
 *     polymorphically — same pattern as `Renderable.draw`.
 *   - A task records one or more `Pass` instances during `record()` (via the
 *     public `addRenderPass(...)` action and friends). `_executeTask()` iterates
 *     `_passes` per frame.
 *
 * Lifecycle:
 *   - Engine and scene are captured at task creation and exposed as
 *     `engine` / `scene`.
 *   - `record()` is called synchronously when the frame graph is built (via
 *     `FrameGraph.build()`). Tasks use this to allocate GPU resources, build
 *     their render-pass descriptor, and finalize anything that needs the
 *     final canvas / target size. Pass instances are created here via
 *     `addRenderPass(fg, name)` and pushed into `_passes`.
 *   - `_executeTask()` is called once per frame and returns the number of draw
 *     calls issued by all recorded passes.
 *   - `dispose()` is called when the frame graph is disposed.
 */

import type { EngineContextInternal } from "../engine/engine.js";
import type { SceneContextInternal } from "../scene/scene-core.js";
import type { Pass } from "./pass.js";

export interface Task {
    readonly name: string;

    /** Engine and scene captured at task creation. */
    readonly engine: EngineContextInternal;
    readonly scene: SceneContextInternal;

    /** Passes recorded by this task. Populated during `record()` by
     *  `createRenderPass(name, task)` / `addRenderPass(fg, name)`.
     *  Mirrors BJS `FrameGraphTask._passes`. */
    _passes: Pass[];

    /** Called once when the frame graph is built. Must complete synchronously. */
    record(): void;

    /** Optional asynchronous preparation run before synchronous frame-graph build. */
    _preload?(): Promise<void>;

    /** Optional fast path for built-in tasks that execute without recorded Pass objects. */
    execute?(): number;

    /** Free all GPU resources owned by this task. */
    dispose(): void;
}
