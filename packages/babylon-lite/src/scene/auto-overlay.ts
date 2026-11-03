import type { SceneContext } from "./scene-core.js";
import { _placeAfterBase, _selectImplicitBase } from "./implicit-overlay-base.js";
import { configureSwapchainOverlayScene } from "./swapchain-overlay.js";

/** Load registry reconciliation on the first scene removal, then use it directly. */
function loadSceneRegistryChanged(scene: SceneContext, removed: boolean): void {
    const engine = scene.surface.engine;
    void import("./auto-overlay-reconcile.js").then((reconcile) => {
        if (engine._sceneOverlayChanged === loadSceneRegistryChanged) {
            engine._sceneOverlayChanged = reconcile.sceneRegistryChanged;
        }
        reconcile.sceneRegistryChanged(scene, removed);
    });
}

/** @internal Configure an ordinary scene and return its post-registration ordering action. */
export function prepareSceneOverlay(scene: SceneContext): (() => void) | undefined {
    const surface = scene.surface;
    if (scene._z || surface._renderingContexts.includes(scene)) {
        return;
    }
    const base = _selectImplicitBase(scene);
    const state = scene._swapchainOverlay;
    if (state?._task) {
        // Re-registered before its removal was reconciled; reconciliation normalizes this state.
        state._base = base;
    } else {
        configureSwapchainOverlayScene(surface, scene, base);
    }
    surface.engine._sceneOverlayChanged ??= loadSceneRegistryChanged;
    return base ? () => _placeAfterBase(surface, scene, base) : undefined;
}
