import type { SceneContext } from "../scene/scene-core.js";
import { addDeferredSceneRenderables } from "../scene/scene-core.js";
import type { BillboardSpriteSystem } from "./billboard-sprite.js";

function addBillboardSystem(scene: SceneContext, system: BillboardSpriteSystem, orientation: BillboardSpriteSystem["_orientation"], helperName: string): void {
    if (system._orientation !== orientation) {
        const article = orientation === "axis-locked" ? "an" : "a";
        throw new Error(`${helperName}: expected ${article} ${orientation} BillboardSpriteSystem, got ${system._orientation}.`);
    }
    addDeferredSceneRenderables(scene, async (engine) => {
        const { buildBillboardRenderable } = await import("./billboard-renderable.js");
        const built = buildBillboardRenderable(engine, system);
        return { renderables: [built.renderable], dispose: built.dispose };
    });
}

export function addFacingBillboardSystem(scene: SceneContext, system: BillboardSpriteSystem): void {
    addBillboardSystem(scene, system, "facing", "addFacingBillboardSystem");
}

export function addAxisLockedBillboardSystem(scene: SceneContext, system: BillboardSpriteSystem): void {
    addBillboardSystem(scene, system, "axis-locked", "addAxisLockedBillboardSystem");
}
