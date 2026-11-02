import type { EngineContext } from "../engine/engine.js";
import type { SurfaceContext } from "../engine/surface.js";
import type { RenderTaskBase as RenderTask } from "../frame-graph/render-task-base.js";
import type { SceneContext } from "./scene-core.js";

interface OverlayState {
    callback?: () => void;
    cleanup: () => void;
    task: RenderTask;
    enabled: boolean | undefined;
    clear: boolean | undefined;
}

let overlayStates: WeakMap<SceneContext, OverlayState> | undefined;

let _sceneOverlayHookLookup: (engine: EngineContext) => EngineContext["_sceneOverlayHooks"] = () => undefined;

function removeCallback<T>(callbacks: T[], callback: T): void {
    const index = callbacks.indexOf(callback);
    if (index >= 0) {
        callbacks.splice(index, 1);
    }
}

/** @internal Install the lookup for optional engine-owned overlay-selection hooks. */
export function _installSwapchainOverlayHookLookup(lookup: (engine: EngineContext) => EngineContext["_sceneOverlayHooks"]): void {
    _sceneOverlayHookLookup = lookup;
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

/** @internal Configure a scene to preserve pixels already rendered into the same surface.
 *  `afterRegistration` permits configuring the first context after registration. */
export function configureSwapchainOverlayScene(surface: SurfaceContext, overlay: SceneContext, afterRegistration = false): void {
    if (overlay._z || (!afterRegistration && surface._renderingContexts.includes(overlay))) {
        return;
    }
    const selected = _sceneOverlayHookLookup(surface.engine)?.selectBase(overlay);
    const baseScene = (selected === undefined ? surface._renderingContexts[surface._renderingContexts.length - 1] : selected) as Partial<SceneContext> | null | undefined;
    if (selected === undefined && !baseScene?._frameGraph) {
        return;
    }

    const previous = overlayStates?.get(overlay);
    if (previous) {
        if (previous.callback) {
            removeCallback(overlay._beforeRender, previous.callback);
            previous.task.enabled = previous.enabled;
        }
        previous.task._config.clr = previous.clear;
        removeCallback(overlay._disposables, previous.cleanup);
        overlayStates?.delete(overlay);
    }

    if (!baseScene?._frameGraph) {
        return;
    }

    const overlayTask = getDefaultSwapchainTask(overlay, surface);
    if (!overlayTask) {
        return;
    }
    const enabled = overlayTask.enabled;
    const clear = overlayTask._config.clr;
    const cleanup = (): void => {
        overlayStates?.delete(overlay);
    };
    const state: OverlayState = { task: overlayTask, enabled, clear, cleanup };
    (overlayStates ??= new WeakMap()).set(overlay, state);
    overlay._disposables.push(cleanup);
    if (surface.msaaSamples === 1) {
        // Load (don't clear) the swapchain so the overlay composites onto the base scene.
        overlayTask._config.clr = false;
        return;
    }
    overlayTask._config.clr = true;
    overlayTask.enabled = false;
    const callback = (): void => {
        const baseTask = getDefaultSwapchainTask(baseScene as SceneContext, surface);
        const view = baseTask?._config.rst === surface.scRT && baseTask._colorAttachment.view;
        overlayTask.enabled = view ? enabled : false;
        overlayTask._config.clr = !view;
        if (view) {
            // Both scenes must use the base task's MSAA colour texture before the overlay
            // can load its pixels and resolve the composited result into the swapchain.
            overlayTask._colorAttachment.view = view;
        }
    };
    overlay._beforeRender.unshift(callback);
    state.callback = callback;
}
