import type { SceneContext } from "../scene/scene-core.js";
import { addBillboardSystemToScene } from "../sprite/billboard-scene.js";
import type { FacingBillboardSpriteSystem } from "../sprite/billboard-sprite.js";
import { attachParticleMultiplyShader, buildParticleBlendBillboardRenderable } from "./particle-billboard-renderable.js";
import { createParticleBlend } from "./particle-blend.js";

/** Add a facing billboard system using Babylon.js particle Multiply or MultiplyAdd rendering when requested.
 *  Either way the system joins the scene's billboard collection (`getSceneBillboardSystems`, `removeBillboardSystemFromScene`),
 *  and re-adding it with `addBillboardSystemToScene` keeps its particle passes. */
export function addFacingBillboardSystemWithParticleBlend(scene: SceneContext, billboard: FacingBillboardSpriteSystem, blendMode: number): void {
    (billboard as { blendMode: FacingBillboardSpriteSystem["blendMode"] }).blendMode = createParticleBlend(blendMode);
    if (billboard.blendMode._particlePasses) {
        attachParticleMultiplyShader(billboard);
        billboard._sceneBuilder = (engine, buildBase) => buildParticleBlendBillboardRenderable(engine, billboard, buildBase);
    }
    addBillboardSystemToScene(scene, billboard);
}
