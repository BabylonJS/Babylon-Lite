import type { SceneContext } from "../scene/scene-core.js";
import { _addBillboardSystemToScene, addBillboardSystemToScene } from "../sprite/billboard-scene.js";
import type { FacingBillboardSpriteSystem } from "../sprite/billboard-sprite.js";
import { attachParticleMultiplyShader, buildParticleBlendBillboardRenderable } from "./particle-billboard-renderable.js";
import { createParticleBlend } from "./particle-blend.js";

/** Add a facing billboard system using Babylon.js particle Multiply or MultiplyAdd rendering when requested.
 *  Either way the system joins the scene's billboard collection (`getSceneBillboardSystems`, `removeBillboardSystemFromScene`). */
export function addFacingBillboardSystemWithParticleBlend(scene: SceneContext, billboard: FacingBillboardSpriteSystem, blendMode: number): void {
    (billboard as { blendMode: FacingBillboardSpriteSystem["blendMode"] }).blendMode = createParticleBlend(blendMode);
    if (!billboard.blendMode._particlePasses) {
        addBillboardSystemToScene(scene, billboard);
        return;
    }
    attachParticleMultiplyShader(billboard);
    _addBillboardSystemToScene(scene, billboard, (engine, buildBase) => buildParticleBlendBillboardRenderable(engine, billboard, buildBase));
}
