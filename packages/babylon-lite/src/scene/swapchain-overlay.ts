import type { EngineContextInternal } from "../engine/engine.js";
import type { RenderTask } from "../frame-graph/render-task.js";
import type { SceneContextInternal } from "./scene-core.js";

function getDefaultSwapchainTask(scene: SceneContextInternal): RenderTask | null {
    const task = scene._frameGraph._tasks[0] as Partial<RenderTask> | undefined;
    if (!task?._config || !task._colorAttachment) {
        return null;
    }
    const renderTask = task as RenderTask;
    return renderTask._config.rt.descriptor.resolveToSwapchain === true ? renderTask : null;
}

/** @internal Configure a later scene to preserve pixels already rendered into the same swapchain. */
export function configureSwapchainOverlayScene(engine: EngineContextInternal, overlay: SceneContextInternal): void {
    const base = engine._renderingContexts[engine._renderingContexts.length - 1] as Partial<SceneContextInternal> | undefined;
    if (!base?._frameGraph) {
        return;
    }
    const baseTask = getDefaultSwapchainTask(base as SceneContextInternal);
    const overlayTask = getDefaultSwapchainTask(overlay);
    if (!baseTask || !overlayTask) {
        return;
    }

    overlayTask._config.clr = false;
    overlay._beforeRender.unshift(() => {
        const view = baseTask._colorAttachment.view;
        if (engine.msaaSamples > 1 && view) {
            overlayTask._colorAttachment.view = view;
        }
    });
}
