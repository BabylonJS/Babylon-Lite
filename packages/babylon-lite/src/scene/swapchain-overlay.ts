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

/** @internal Composite an overlay scene's current swapchain task onto its `_overlayBase`.
 *  Wraps the overlay's record, so it runs after every before-render callback and re-resolves the
 *  task each frame: tasks added or replaced after creation are configured, and a replaced task gets
 *  its clear state and own colour view back. At MSAA, a frame without a shareable base attachment
 *  skips the task by disabling it only for that record, leaving the app's `enabled` gate intact. */
export function configureSwapchainOverlayScene(overlay: SceneContext): void {
    const surface = overlay.surface;
    const record = overlay._record;
    let task: RenderTask | undefined;
    let clr: boolean | undefined;
    overlay._record = () => {
        const current = getDefaultSwapchainTask(overlay, surface);
        if (current !== task) {
            if (task) {
                task._config.clr = clr;
                task._colorAttachment.view = task._config.rt._colorView!;
            }
            task = current;
            clr = current?._config.clr;
        }
        if (current) {
            if (surface.msaaSamples > 1) {
                // Every overlay in a chain composites into the root scene's MSAA colour texture.
                let root = overlay._overlayBase!;
                while (root._overlayBase) {
                    root = root._overlayBase;
                }
                const rootTask = getDefaultSwapchainTask(root, surface);
                // A root that did not render this frame (disabled or paused), or that does not resolve into
                // the swapchain (post-process/copy), has no colour the overlay can load and resolve.
                const view = rootTask?.enabled !== false && rootTask?.executionEnabled !== false && rootTask?._config.rst === surface.scRT && rootTask._colorAttachment.view;
                if (!view) {
                    const enabled = current.enabled;
                    current.enabled = false;
                    try {
                        return record();
                    } finally {
                        current.enabled = enabled;
                    }
                }
                current._colorAttachment.view = view;
            }
            // Load (don't clear) so the overlay composites onto the base scene's colour.
            current._config.clr = false;
        }
        return record();
    };
}
