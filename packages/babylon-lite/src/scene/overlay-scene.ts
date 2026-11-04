import type { RenderingContext } from "../engine/engine.js";
import { isRenderingContextRegistered } from "../engine/engine.js";
import { moveRenderingContext } from "../engine/rendering-context-order.js";
import type { SceneContext } from "./scene-core.js";
import { _installOverlaySceneRegistration, createSceneContext } from "./scene-core.js";
import { configureSwapchainOverlayScene } from "./swapchain-overlay.js";

function isOverlayDescendant(context: RenderingContext, base: SceneContext): boolean {
    let parent = (context as Partial<SceneContext>)._overlayBase;
    while (parent) {
        if (parent === base) {
            return true;
        }
        parent = parent._overlayBase;
    }
    return false;
}

function moveOverlayDescendants(base: SceneContext, baseIndex: number): number {
    const surface = base.surface;
    const contexts = surface._renderingContexts;
    const overlays = contexts.filter((context): context is SceneContext => "_overlayBase" in context && context._overlayBase === base);
    for (const overlay of overlays) {
        baseIndex++;
        if (contexts[baseIndex] !== overlay) {
            moveRenderingContext(surface, overlay, baseIndex);
        }
        baseIndex = moveOverlayDescendants(overlay, baseIndex);
    }
    return baseIndex;
}

/** @internal Keep the overlay tree containing `scene` together, depth-first. Grouping starts at
 *  the tree's root and waits until that root is registered, so siblings keep registration order. */
export function moveSwapchainOverlaysAfterBase(scene: SceneContext): void {
    let base = scene;
    while (base._overlayBase) {
        base = base._overlayBase;
    }
    const surface = base.surface;
    const contexts = surface._renderingContexts;
    let baseIndex = contexts.indexOf(base);
    if (baseIndex === -1) {
        return;
    }
    const firstDescendantIndex = contexts.findIndex((context) => isOverlayDescendant(context, base));
    if (firstDescendantIndex === -1) {
        return;
    }
    if (firstDescendantIndex < baseIndex) {
        moveRenderingContext(surface, base, firstDescendantIndex);
        baseIndex = firstDescendantIndex;
    }
    moveOverlayDescendants(base, baseIndex);
}

/** Whether any scene in `scene`'s explicit overlay chain is unregistered. */
function isSuspended(scene: SceneContext): boolean {
    let base = scene._overlayBase;
    while (base && isRenderingContextRegistered(scene.surface, base)) {
        base = base._overlayBase;
    }
    return !!base;
}

/**
 * Create a scene that composites over `baseScene` on the base scene's surface.
 *
 * The overlay keeps its own camera, lights, and freshly cleared depth buffer, but
 * preserves the base scene's color: single-sample surfaces load the swapchain, and
 * MSAA surfaces render into the base scene's multisample color attachment before
 * resolving it again. Register it with {@link registerScene} in either order relative
 * to the base; registration keeps every overlay immediately after its base (sibling
 * overlays in registration order, nested overlays depth-first), so later contexts such
 * as text renderers draw on top. While the base scene (or any scene in its overlay
 * chain) is not registered, the overlay stays registered but does no update or render work.
 */
export function createOverlayScene(baseScene: SceneContext): SceneContext {
    const scene = createSceneContext(baseScene.surface);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 0 };
    scene._overlayBase = baseScene;
    _installOverlaySceneRegistration(moveSwapchainOverlaysAfterBase);
    configureSwapchainOverlayScene(scene);

    const update = scene._update;
    const record = scene._record;
    scene._update = () => {
        if (isSuspended(scene)) {
            scene._drawCallsPre = 0;
        } else {
            update();
        }
    };
    scene._record = () => (isSuspended(scene) ? 0 : record());
    return scene;
}
