import type { SceneContext } from "../scene/scene-core.js";
import { _addSceneRenderable, _getSceneRenderables, _observeSceneRenderables, _removeSceneRenderable } from "../scene/scene-renderable-collection.js";
import type { SceneRenderableChangeListener } from "../scene/scene-renderable-collection.js";
import type { Sprite2DLayer } from "./sprite-2d.js";
import { buildSpriteRenderable } from "./sprite-renderable.js";

/**
 * Adds a depth-hosted Sprite2D layer to the scene so it is drawn, depth-tested against scene geometry, once the
 * scene builds. Adding a member again does nothing. Pure HUD layers (`depth: "none"`) are rendered by
 * `createSpriteRenderer + registerSpriteRenderer` instead.
 */
export function addDepthHostedSpriteLayerToScene(scene: SceneContext, layer: Sprite2DLayer): void {
    if (layer.depth === "none") {
        throw new Error('Depth-hosted sprites require depth != "none".');
    }
    _addSceneRenderable(scene, "depthSprite", layer, (engine) => {
        const built = buildSpriteRenderable(engine, layer);
        return { _renderable: built.renderable, _detach: () => built.dispose };
    });
}

/**
 * Removes a depth-hosted Sprite2D layer from the scene. It stops drawing immediately; its scene-built GPU resources
 * are released once in-flight frames finish. Returns `false` when the layer was not in the scene.
 */
export function removeDepthHostedSpriteLayerFromScene(scene: SceneContext, layer: Sprite2DLayer): boolean {
    return _removeSceneRenderable(scene, "depthSprite", layer);
}

/** Returns a snapshot of the scene's depth-hosted Sprite2D layers, in add order. */
export function getSceneDepthHostedSpriteLayers(scene: SceneContext): readonly Sprite2DLayer[] {
    return _getSceneRenderables(scene, "depthSprite");
}

/** Subscribes to the scene's depth-hosted Sprite2D layer membership changes. The returned callback unsubscribes (idempotent). */
export function onSceneDepthHostedSpriteLayersChanged(scene: SceneContext, listener: SceneRenderableChangeListener<Sprite2DLayer>): () => void {
    return _observeSceneRenderables(scene, "depthSprite", listener);
}
