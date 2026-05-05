import type { EngineContextInternal } from "../engine/engine.js";
import type { SceneContext, SceneContextInternal } from "../scene/scene-core.js";
import type { Sprite2DLayer } from "./sprite-2d.js";
import { buildSpriteRenderable } from "./sprite-renderable.js";

/** Add a depth-hosted Sprite2DLayer to a scene's frame-graph renderable list. */
export function addSprite2DLayerToScene(scene: SceneContext, layer: Sprite2DLayer): void {
    if (layer.depth === "none") {
        throw new Error('Sprite2DLayer with depth: "none" must be rendered via createSpriteRenderer, not addSprite2DLayerToScene.');
    }
    const ctx = scene as SceneContextInternal;
    ctx._deferredBuilders.push(() => {
        const built = buildSpriteRenderable(ctx.engine as EngineContextInternal, layer);
        ctx._renderables.push(built.renderable);
        ctx._disposables.push(built.dispose);
    });
}
