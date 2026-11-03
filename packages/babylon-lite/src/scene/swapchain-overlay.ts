import type { SurfaceContext } from "../engine/surface.js";
import type { RenderTaskBase as RenderTask } from "../frame-graph/render-task-base.js";
import type { SceneContext } from "./scene-core.js";

/** @internal A scene's swapchain-composition record. `_task` is set only while compositing onto `_base`. */
export interface SwapchainOverlayState {
    /** @internal The scene composited onto, or `null` for a normal clearing scene. */
    _base: SceneContext | null;
    /** @internal The scene's swapchain task while compositing. */
    _task?: RenderTask;
    /** @internal The task's original enabled state. */
    _enabled?: boolean;
    /** @internal The task's original clear flag. */
    _clear?: boolean;
    /** @internal The MSAA before-render callback that shares the base's attachment. */
    _callback?: () => void;
}

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

/** @internal Configure an unconfigured scene to preserve its selected base scene's pixels and
 *  record the result in `_swapchainOverlay`. A `null` base records the scene with its task untouched.
 *  Reconfiguring an already-configured scene requires `retargetSwapchainOverlay`. */
export function configureSwapchainOverlayScene(surface: SurfaceContext, overlay: SceneContext, baseScene: SceneContext | null): void {
    const state: SwapchainOverlayState = (overlay._swapchainOverlay = { _base: baseScene });
    const task = baseScene && getDefaultSwapchainTask(overlay, surface);
    if (!task) {
        return;
    }
    state._task = task;
    state._enabled = task.enabled;
    state._clear = task._config.clr;
    if (surface.msaaSamples === 1) {
        // Load (don't clear) the swapchain so the overlay composites onto the base scene.
        task._config.clr = false;
        return;
    }
    task._config.clr = true;
    task.enabled = false;
    state._callback = (): void => {
        // `_base` may be retargeted or unregistered; never share an absent scene's attachment.
        const base = state._base;
        const baseTask = base && surface._renderingContexts.includes(base) ? getDefaultSwapchainTask(base, surface) : undefined;
        const view = baseTask?._config.rst === surface.scRT && baseTask._colorAttachment.view;
        task.enabled = view ? state._enabled : false;
        task._config.clr = !view;
        if (view) {
            // Both scenes must use the base task's MSAA colour texture before the overlay
            // can load its pixels and resolve the composited result into the swapchain.
            task._colorAttachment.view = view;
        }
    };
    overlay._beforeRender.unshift(state._callback);
}
