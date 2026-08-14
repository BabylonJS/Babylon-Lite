import type { SceneContext } from "../scene/scene-core.js";
import { _addDecoratedBillboardSystem, addFacingBillboardSystem } from "../sprite/billboard-scene.js";
import type { FacingBillboardSpriteSystem } from "../sprite/billboard-sprite.js";
import { decorateParticleBillboardRenderable } from "./particle-billboard-renderable.js";

/** Add a particle billboard to a scene, including Babylon.js Multiply and MultiplyAdd rendering. */
export function addParticleBillboardSystem(scene: SceneContext, system: FacingBillboardSpriteSystem): void {
    if (!system.blendMode._particlePasses) {
        addFacingBillboardSystem(scene, system);
        return;
    }
    _addDecoratedBillboardSystem(scene, system, decorateParticleBillboardRenderable);
}
