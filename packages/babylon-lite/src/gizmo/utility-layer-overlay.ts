import type { EngineContext, RenderingContext } from "../engine/engine.js";
import { moveRenderingContext } from "../engine/rendering-context-order.js";
import type { SceneContext } from "../scene/scene-core.js";
import { _installSceneOverlayHookLookup } from "../scene/scene-core.js";
import { _installSwapchainOverlayHookLookup, configureSwapchainOverlayScene } from "../scene/swapchain-overlay.js";

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

/** @internal Keep a scene and its explicitly associated swapchain overlays together. */
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

/** @internal Install utility-layer composition hooks on the owning engine. */
export function enableUtilityLayerOverlays(engine: EngineContext): void {
    if (engine._sceneOverlayHooks) {
        return;
    }
    engine._sceneOverlayHooks = { selectBase, registered: sceneRegistered };
    _installSceneOverlayHookLookup(getSceneOverlayHooks);
    _installSwapchainOverlayHookLookup(getSceneOverlayHooks);
}
