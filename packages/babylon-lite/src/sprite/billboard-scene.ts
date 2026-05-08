import type { SceneContext } from "../scene/scene-core.js";
import { addDeferredSceneRenderables } from "../scene/scene-core.js";
import type { BillboardSpriteSystem } from "./billboard-sprite.js";
import { buildFacingBillboardRenderable } from "./billboard-renderable.js";

export function addFacingBillboardSystem(scene: SceneContext, system: BillboardSpriteSystem): void {
    addDeferredSceneRenderables(scene, (engine) => {
        const built = buildFacingBillboardRenderable(engine, system);
        return { renderables: [built.renderable], dispose: built.dispose };
    });
}
