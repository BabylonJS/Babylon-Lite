import type { SceneContext } from "../scene/scene-core.js";
import { addDeferredSceneRenderables } from "../scene/scene-core.js";
import { registerPickSource } from "../picking/pick-contributor.js";
import { addFacingBillboardSystem } from "../sprite/billboard-scene.js";
import type { FacingBillboardSpriteSystem } from "../sprite/billboard-sprite.js";
import { attachParticleMultiplyShader, buildParticleBlendBillboardRenderable } from "./particle-billboard-renderable.js";
import { createParticleBlend } from "./particle-blend.js";

/** Add a facing billboard system using Babylon.js particle Multiply or MultiplyAdd rendering when requested. */
export function addFacingBillboardSystemWithParticleBlend(scene: SceneContext, billboard: FacingBillboardSpriteSystem, blendMode: number): void {
    (billboard as { blendMode: FacingBillboardSpriteSystem["blendMode"] }).blendMode = createParticleBlend(blendMode);
    if (!billboard.blendMode._particlePasses) {
        addFacingBillboardSystem(scene, billboard);
        return;
    }
    attachParticleMultiplyShader(billboard);
    scene._disposables.push(registerPickSource(scene, billboard, () => import("../picking/billboard-pick-pipeline.js")));
    addDeferredSceneRenderables(scene, async (engine) => {
        const { buildBillboardRenderable } = await import("../sprite/billboard-renderable.js");
        const built = buildParticleBlendBillboardRenderable(engine, billboard, buildBillboardRenderable);
        return { renderables: [built.renderable], dispose: built.dispose };
    });
}
