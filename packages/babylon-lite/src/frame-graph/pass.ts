/**
 * Pass — the base interface every frame-graph pass implements.
 *
 * Modelled on Babylon.js' `IFrameGraphPass`. A `Task` records one or more
 * passes during `Task.record()` (via the public `addRenderPass(...)` action,
 * etc.), and the shared `_executeTask()` helper iterates `task._passes`
 * calling `pass._execute()`. Today the only concrete pass type is `RenderPass`;
 * future compute / copy / object-list passes will share this same shape.
 *
 * Lifecycle:
 *   - `_initialize()` runs once after all tasks have finished recording, so
 *     a pass can defer descriptor construction until any RT textures it
 *     depends on are built. RenderPass uses this to assemble its cached
 *     `GPURenderPassDescriptor`.
 *   - `_execute()` runs once per frame from `_executeTask()` and performs this
 *     pass's concrete GPU work. It returns the number of draw calls issued
 *     (passed back up to the engine's per-frame draw counter).
 *   - `_dispose()` frees any pass-owned GPU/CPU state.
 *
 * Conventions:
 *   - Pure-state interface, no methods on the user-facing surface beyond
 *     the lifecycle hooks. Configuration goes through standalone functions
 *     (e.g. `addPassDependencies`, `setRenderPassRenderTarget`).
 */

import type { RenderTarget } from "../engine/render-target.js";
import type { Task } from "./task.js";

/** Body of a render pass — receives the live render-pass encoder and returns
 *  the number of draws issued. */
export type RenderPassExecuteFunc = (pass: GPURenderPassEncoder) => number;

/** Base interface every frame-graph pass implements: a named unit of GPU work with `_initialize` / `_execute` / `_dispose` lifecycle hooks. */
export interface Pass {
    readonly name: string;

    /** The task that owns this pass. Set on creation via `createRenderPass`. */
    _parentTask: Task;

    /** Render targets (textures) this pass references. Used (later) by the
     *  texture manager to compute lifetimes / aliasing. Lifted from BJS'
     *  `FrameGraphRenderPass` so future compute / copy / object-list passes
     *  share the same surface without re-introducing it per pass type. */
    _dependencies: Set<RenderTarget>;

    /** Body of the pass (issues GPU work). Set via `setRenderPassExecuteFunc`. */
    _executeFunc: RenderPassExecuteFunc | null;
    /** Optional per-frame preparation that runs before `_executeFunc`. */
    _beforeExecute: (() => void) | null;

    /** Called once after every task has recorded. Use to build caches that
     *  depend on RT textures being allocated (RenderPass builds its
     *  `GPURenderPassDescriptor` here). May be a no-op. */
    _initialize(): void;

    /** Called once per frame by `_executeTask()`. Performs this pass's concrete
     *  GPU work and returns the number of draw calls issued. */
    _execute(): number;

    /** Free pass-owned GPU/CPU state. Idempotent. */
    _dispose(): void;
}

/** Add one or more render-target dependencies to the pass. Idempotent
 *  (Set semantics). Mirrors BJS `FrameGraphRenderPass.addDependencies`,
 *  promoted onto the base `Pass` because every future pass type
 *  (compute / copy / object-list) needs the same surface. */
export function addPassDependencies(pass: Pass, deps: RenderTarget | readonly RenderTarget[]): void {
    if (Array.isArray(deps)) {
        for (const dep of deps) {
            pass._dependencies.add(dep);
        }
    } else {
        pass._dependencies.add(deps as RenderTarget);
    }
}

/** Set the per-frame body of the pass. Mirrors BJS `setExecuteFunc`. */
export function setRenderPassExecuteFunc(pass: Pass, fn: RenderPassExecuteFunc): void {
    pass._executeFunc = fn;
}

/** Set optional per-frame preparation that runs before the pass body. */
export function setRenderPassBeforeExecute(pass: Pass, fn: () => void): void {
    pass._beforeExecute = fn;
}
