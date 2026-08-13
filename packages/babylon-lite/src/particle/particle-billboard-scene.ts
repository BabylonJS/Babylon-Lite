import { registerPickSource } from "../picking/pick-contributor.js";
import type { SceneContext } from "../scene/scene-core.js";
import { addDeferredSceneRenderables } from "../scene/scene-core.js";
import type { FacingBillboardSpriteSystem } from "../sprite/billboard-sprite.js";

/** Add a particle billboard to a scene, including Babylon.js Multiply and MultiplyAdd rendering. */
export function addParticleBillboardSystem(scene: SceneContext, system: FacingBillboardSpriteSystem): void {
    const blendKey = system.blendMode._key;
    const multiply = blendKey === "p3" || blendKey === "p4";
    const addPass = blendKey === "p4";
    scene._disposables.push(registerPickSource(scene, system, () => import("../picking/billboard-pick-pipeline.js")));
    addDeferredSceneRenderables(scene, async (engine) => {
        if (multiply) {
            const { buildParticleMultiplyBillboardRenderable } = await import("./particle-billboard-renderable.js");
            const built = buildParticleMultiplyBillboardRenderable(engine, system, addPass);
            return { renderables: [built.renderable], dispose: built.dispose };
        }
        const { buildBillboardRenderable } = await import("../sprite/billboard-renderable.js");
        const built = buildBillboardRenderable(engine, system);
        return { renderables: [built.renderable], dispose: built.dispose };
    });
}
