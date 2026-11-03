import type { SurfaceContext } from "../engine/surface.js";
import type { SceneContext } from "./scene-core.js";

/**
 * @internal Select the scene an ordinary scene composites onto: the nearest earlier scene in
 * render order. The search stops at the scene itself or its first explicit overlay (an unregistered
 * scene is ordered before its overlays) and skips overlays whose base chain is not registered.
 */
export function _selectImplicitBase(scene: SceneContext): SceneContext | null {
    const contexts = scene.surface._renderingContexts as SceneContext[];
    let base: SceneContext | null = null;
    for (const context of contexts) {
        let active = context._kind === "scene";
        for (let parent: SceneContext | undefined = context; parent; parent = parent._overlayBase) {
            if (parent === scene) {
                return base;
            }
            active &&= contexts.includes(parent);
        }
        if (active) {
            base = context;
        }
    }
    return base;
}

/** @internal Move a registered scene immediately after its base. */
export function _placeAfterBase(surface: SurfaceContext, scene: SceneContext, base: SceneContext): void {
    const contexts = surface._renderingContexts;
    contexts.splice(contexts.indexOf(scene), 1);
    contexts.splice(contexts.indexOf(base) + 1, 0, scene);
}
