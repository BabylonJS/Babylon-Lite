import type { EngineContext, RenderingContext } from "../engine/engine.js";
import { isRenderingContextRegistered } from "../engine/engine.js";
import { moveRenderingContext } from "../engine/rendering-context-order.js";
import type { SceneContext } from "./scene-core.js";
import { _installSceneOverlayHookLookup, createSceneContext } from "./scene-core.js";
import { _installSwapchainOverlayHookLookup, configureSwapchainOverlayScene } from "./swapchain-overlay.js";

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

/** @internal Keep a scene and its explicitly associated overlay scenes together, depth-first. */
export function moveSwapchainOverlaysAfterBase(base: SceneContext): void {
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

function selectBase(scene: SceneContext): RenderingContext | null | undefined {
    if (scene._overlayBase) {
        return scene._overlayBase;
    }
    const contexts = scene.surface._renderingContexts;
    if (contexts.length === 1 && contexts[0] === scene) {
        return null;
    }
    const firstDescendant = contexts.findIndex((context) => isOverlayDescendant(context, scene));
    return firstDescendant < 0 ? undefined : (contexts[firstDescendant - 1] ?? null);
}

function sceneRegistered(scene: SceneContext): void {
    if (scene.surface._renderingContexts.length === 1) {
        configureSwapchainOverlayScene(scene.surface, scene, true);
    }
    moveSwapchainOverlaysAfterBase(scene._overlayBase ?? scene);
}

function getSceneOverlayHooks(engine: EngineContext): EngineContext["_sceneOverlayHooks"] {
    return engine._sceneOverlayHooks;
}

/** @internal Install explicit overlay-scene composition hooks on the owning engine. */
export function enableOverlayScenes(engine: EngineContext): void {
    if (engine._sceneOverlayHooks) {
        return;
    }
    engine._sceneOverlayHooks = { selectBase, registered: sceneRegistered };
    _installSceneOverlayHookLookup(getSceneOverlayHooks);
    _installSwapchainOverlayHookLookup(getSceneOverlayHooks);
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
    enableOverlayScenes(baseScene.surface.engine);

    const isActive = (): boolean => {
        for (let base: SceneContext | undefined = baseScene; base; base = base._overlayBase) {
            if (!isRenderingContextRegistered(scene.surface, base)) {
                return false;
            }
        }
        return true;
    };
    const update = scene._update;
    const record = scene._record;
    scene._update = () => {
        if (isActive()) {
            update();
        } else {
            scene._drawCallsPre = 0;
        }
    };
    scene._record = () => (isActive() ? record() : 0);
    return scene;
}
