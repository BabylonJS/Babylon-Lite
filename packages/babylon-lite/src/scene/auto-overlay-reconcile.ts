import { _placeAfterBase, _selectImplicitBase } from "./implicit-overlay-base.js";
import { restoreSwapchainOverlay, retargetSwapchainOverlay } from "./overlay-lifecycle.js";
import type { SceneContext } from "./scene-core.js";
/** @internal Reconcile ordinary scene composition after a scene is removed or an explicit overlay registers. */
export function sceneRegistryChanged(scene: SceneContext, removed: boolean): void {
    const surface = scene.surface;
    if (removed && !surface._renderingContexts.includes(scene)) {
        restoreSwapchainOverlay(scene);
    }
    for (const context of surface._renderingContexts.slice()) {
        const candidate = context as SceneContext;
        const state = candidate._swapchainOverlay;
        if (!state || candidate._overlayBase) {
            continue;
        }
        const base = _selectImplicitBase(candidate);
        if (base !== state._base || (!base && state._task)) {
            retargetSwapchainOverlay(surface, candidate, base);
        }
        if (base) {
            _placeAfterBase(surface, candidate, base);
        }
    }
}
