import type { SurfaceContext } from "../engine/surface.js";
import type { RenderTask } from "../frame-graph/render-task.js";
import type { SceneContext } from "./scene-core.js";

/** Find a scene's default render task that targets the surface swapchain — either
 *  directly (`rt === scRT`, single-sample) or via an MSAA resolve
 *  (`rst === scRT`, MSAA). */
function getDefaultSwapchainTask(scene: SceneContext, surface: SurfaceContext): RenderTask | null {
    for (const task of scene._frameGraph._tasks) {
        const ptask = task as Partial<RenderTask> | undefined;
        if (!ptask?._config || !ptask._colorAttachment) {
            continue;
        }
        const renderTask = task as RenderTask;
        if (renderTask._config.rt === surface.scRT || renderTask._config.rst === surface.scRT) {
            return renderTask;
        }
    }
    return null;
}

/** @internal Configure a later scene to preserve pixels already rendered into the same
 *  surface swapchain. */
export function configureSwapchainOverlayScene(surface: SurfaceContext, overlay: SceneContext): void {
    const base = surface._renderingContexts[surface._renderingContexts.length - 1] as Partial<SceneContext> | undefined;
    if (!base?._frameGraph) {
        return;
    }
    const baseTask = getDefaultSwapchainTask(base as SceneContext, surface);
    const overlayTask = getDefaultSwapchainTask(overlay, surface);
    if (!baseTask || !overlayTask) {
        return;
    }

    // Load (don't clear) the swapchain so the overlay composites onto the base scene.
    overlayTask._config.clr = false;
    overlay._beforeRender.unshift(() => {
        if (surface.msaaSamples > 1) {
            // MSAA: both scenes resolve into the swapchain. To composite, the overlay must
            // render into the SAME MSAA colour texture the base scene rendered into (it holds
            // the base pixels), then resolve to the swap. The base's MSAA colour view is its
            // task's `rt._colorView` (its `rst` is the swap). executePass leaves an offscreen
            // att.view untouched (only the scRT is re-read per frame), so this
            // override survives to execute; the overlay still resolves via its own `rst`.
            const view = baseTask._config.rt._colorView;
            if (view) {
                overlayTask._colorAttachment.view = view;
            }
        }
    });
}
