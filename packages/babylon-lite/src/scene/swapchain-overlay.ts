import type { SurfaceContext } from "../engine/surface.js";
import type { RenderTaskBase as RenderTask } from "../frame-graph/render-task-base.js";
import type { SceneContext } from "./scene-core.js";

/** Find a scene's default render task that targets the surface swapchain — either
 *  directly (`rt === scRT`, single-sample) or via an MSAA resolve
 *  (`rst === scRT`, MSAA). */
function getDefaultSwapchainTask(scene: SceneContext, surface: SurfaceContext): RenderTask | undefined {
    for (const task of scene._frameGraph._tasks as Array<Partial<RenderTask> | undefined>) {
        if (task?._config && task._colorAttachment && (task._config.rt === surface.scRT || task._config.rst === surface.scRT)) {
            return task as RenderTask;
        }
    }
}

/** @internal Keep an overlay scene's current swapchain task compositing onto its `_overlayBase`.
 *  One callback re-resolves the task every frame, so tasks added or replaced after creation or
 *  registration are configured and a replaced task gets its own settings back. It runs inside the
 *  overlay's update, which is skipped while any scene in its base chain is unregistered. */
export function configureSwapchainOverlayScene(overlay: SceneContext): void {
    const surface = overlay.surface;
    let task: RenderTask | undefined;
    let enabled: boolean | undefined;
    let clr: boolean | undefined;
    overlay._beforeRender.unshift(() => {
        const current = getDefaultSwapchainTask(overlay, surface);
        if (current !== task) {
            if (task) {
                task.enabled = enabled;
                task._config.clr = clr;
            }
            task = current;
            enabled = current?.enabled;
            clr = current?._config.clr;
        }
        if (!current) {
            return;
        }
        if (surface.msaaSamples === 1) {
            // Load (don't clear) the swapchain so the overlay composites onto the base scene.
            current._config.clr = false;
            return;
        }
        const baseTask = getDefaultSwapchainTask(overlay._overlayBase!, surface);
        // A disabled base (e.g. a nested overlay whose own base has no shareable attachment)
        // renders nothing this frame, so its colour view must not be loaded and resolved.
        const view = baseTask?.enabled !== false && baseTask?._config.rst === surface.scRT && baseTask._colorAttachment.view;
        current.enabled = view ? enabled : false;
        current._config.clr = !view;
        if (view) {
            // Both scenes must use the base task's MSAA colour texture before the overlay
            // can load its pixels and resolve the composited result into the swapchain.
            current._colorAttachment.view = view;
        }
    });
}
