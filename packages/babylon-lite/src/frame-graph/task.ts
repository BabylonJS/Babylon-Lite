/**
 * Task — the polymorphic interface that all frame-graph tasks must implement.
 *
 * Modelled on Babylon.js' `FrameGraphTask`, but pared down for Babylon-Lite:
 *   - We do NOT (yet) split a task into multiple sub-passes; each task owns and
 *     executes its own GPU work directly.
 *   - The interface uses methods (rather than free functions) so the frame graph
 *     can dispatch polymorphically — same pattern as `Renderable.bind` and
 *     `DrawBinding.draw`.
 *
 * Lifecycle:
 *   - Engine and scene are captured at task creation and exposed as `engine` / `scene`.
 *   - `record()` is called once when the frame graph is built. The task uses this
 *     hook to run any deferred user-supplied builders, allocate its GPU resources,
 *     and finalize its draw bindings.
 *   - `execute(encoder)` is called once per frame and is responsible for encoding
 *     the GPU work for this task. It returns the number of draw calls issued. The
 *     current swapchain view (if needed) is available on `engine._swapChainView`.
 */
import type { EngineContextInternal } from "../engine/engine.js";
import type { SceneContextInternal } from "../scene/scene.js";

export interface Task {
    readonly name: string;

    /** Engine and scene captured at task creation. */
    readonly engine: EngineContextInternal;
    readonly scene: SceneContextInternal;

    /** Called once when the frame graph is built. May be async (asset loaders, etc.). */
    record(): Promise<void> | void;

    /** Called once per frame. Returns the number of GPU draw calls issued. */
    execute(encoder: GPUCommandEncoder): number;

    /** Free all GPU resources owned by this task. Called when the frame graph is disposed. */
    dispose(): void;
}
