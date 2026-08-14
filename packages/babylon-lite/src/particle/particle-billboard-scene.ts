import type { SceneContext } from "../scene/scene-core.js";
import { _addDecoratedBillboardSystem, addFacingBillboardSystem } from "../sprite/billboard-scene.js";
import type { FacingBillboardSpriteSystem } from "../sprite/billboard-sprite.js";
import { decorateParticleBillboardRenderable } from "./particle-billboard-renderable.js";

/** Add a facing billboard system using Babylon.js particle Multiply or MultiplyAdd rendering when requested. */
export function addFacingBillboardSystemWithParticleBlend(scene: SceneContext, billboard: FacingBillboardSpriteSystem): void {
    if (!billboard.blendMode._particlePasses) {
        addFacingBillboardSystem(scene, billboard);
        return;
    }
    _addDecoratedBillboardSystem(scene, billboard, decorateParticleBillboardRenderable);
}
