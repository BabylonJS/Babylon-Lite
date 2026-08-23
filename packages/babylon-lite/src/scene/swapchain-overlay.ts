import type { SurfaceContext } from "../engine/surface.js";
import type { RenderTask } from "../frame-graph/render-task.js";
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

/** @internal Configure a later scene to preserve pixels already rendered into the same
 *  surface swapchain. */
export function configureSwapchainOverlayScene(surface: SurfaceContext, overlay: SceneContext): void {
    const baseScene = surface._renderingContexts[surface._renderingContexts.length - 1] as Partial<SceneContext> | undefined;
    if (!baseScene?._frameGraph) {
        return;
    }
    const overlayTask = getDefaultSwapchainTask(overlay, surface);
    if (!overlayTask) {
        return;
    }
    if (surface.msaaSamples === 1) {
        // Load (don't clear) the swapchain so the overlay composites onto the base scene.
        overlayTask._config.clr = false;
        return;
    }
    const enabled = overlayTask.enabled;
    overlayTask._config.clr = true;
    overlayTask.enabled = false;
    overlay._beforeRender.unshift(() => {
        const baseTask = getDefaultSwapchainTask(baseScene as SceneContext, surface);
        const view = baseTask?._config.rst === surface.scRT && baseTask._config.rt._colorView;
        overlayTask.enabled = view ? enabled : false;
        overlayTask._config.clr = !view;
        if (view) {
            // Both scenes must use the base task's MSAA colour texture before the overlay
            // can load its pixels and resolve the composited result into the swapchain.
            overlayTask._colorAttachment.view = view;
        }
    });
}
