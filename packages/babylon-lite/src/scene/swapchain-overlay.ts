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

/** @internal Configure an overlay scene to preserve its `_overlayBase` scene's swapchain pixels.
 *  The overlay's update (and so this callback) runs only while its whole base chain is registered. */
export function configureSwapchainOverlayScene(overlay: SceneContext): void {
    const surface = overlay.surface;
    const task = getDefaultSwapchainTask(overlay, surface);
    if (!task) {
        return;
    }
    if (surface.msaaSamples === 1) {
        // Load (don't clear) the swapchain so the overlay composites onto the base scene.
        task._config.clr = false;
        return;
    }
    const enabled = task.enabled;
    task._config.clr = true;
    task.enabled = false;
    overlay._beforeRender.unshift(() => {
        const baseTask = getDefaultSwapchainTask(overlay._overlayBase!, surface);
        const view = baseTask?._config.rst === surface.scRT && baseTask._colorAttachment.view;
        task.enabled = view ? enabled : false;
        task._config.clr = !view;
        if (view) {
            // Both scenes must use the base task's MSAA colour texture before the overlay
            // can load its pixels and resolve the composited result into the swapchain.
            task._colorAttachment.view = view;
        }
    });
}
