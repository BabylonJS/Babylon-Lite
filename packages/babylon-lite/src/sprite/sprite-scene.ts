import type { SceneContext } from "../scene/scene-core.js";
import { addDeferredSceneRenderables } from "../scene/scene-core.js";
import type { Sprite2DLayer } from "./sprite-2d.js";
import { buildSpriteRenderable } from "./sprite-renderable.js";

/**
 * Add a depth-hosted Sprite2D layer to a SceneContext via the scene's optional
 * renderable extension hook. Pure HUD layers (`depth: "none"`) are rendered by
 * `createSpriteRenderer + registerSpriteRenderer` instead.
 */
export function addDepthHostedSpriteLayer(scene: SceneContext, layer: Sprite2DLayer): void {
    if (layer.depth === "none") {
        throw new Error('Depth-hosted sprites require depth != "none".');
    }
    addDeferredSceneRenderables(scene, (engine) => {
        const built = buildSpriteRenderable(engine, layer);
        return { renderables: [built.renderable], dispose: built.dispose };
    });
}
