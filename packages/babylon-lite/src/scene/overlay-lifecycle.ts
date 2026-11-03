import type { SurfaceContext } from "../engine/surface.js";
import type { SceneContext } from "./scene-core.js";
import { configureSwapchainOverlayScene } from "./swapchain-overlay.js";

/** @internal Restore a scene's own swapchain task state and forget its composition record. */
export function restoreSwapchainOverlay(scene: SceneContext): void {
    const state = scene._swapchainOverlay;
    const task = state?._task;
    if (task) {
        if (state._callback) {
            const callbacks = scene._beforeRender;
            const index = callbacks.indexOf(state._callback);
            if (index >= 0) {
                callbacks.splice(index, 1);
            }
            task.enabled = state._enabled;
            task._colorAttachment.view = task._config.rt._colorView!;
        }
        task._config.clr = state._clear;
    }
    scene._swapchainOverlay = undefined;
}

/** @internal Restore any previous composition, then composite `scene` onto `base`. */
export function retargetSwapchainOverlay(surface: SurfaceContext, scene: SceneContext, base: SceneContext | null): void {
    restoreSwapchainOverlay(scene);
    configureSwapchainOverlayScene(surface, scene, base);
}
