/**
 * Spherical billboard — sprites face the camera fully.
 *
 * Quad basis: `cameraRight` and `cameraUp` from the per-scene
 * `Sprite3DSceneUBO`. The camera right/up are pre-extracted on the CPU side
 * each frame, so the vertex shader does no basis math beyond a rotation.
 */

import type { SpriteAtlas } from "./shared/sprite-atlas.js";
import type { BillboardBasisFn, BillboardSpriteSystem, BillboardSpriteSystemOptions } from "./sprite-billboard-shared.js";
import { _createBillboardSystem } from "./sprite-billboard-shared.js";

/** Spherical basis: aligned with the camera's right + up axes (per-system,
 *  not per-sprite — closure has no captured state, so it is safe to share). */
const facingBasisFn: BillboardBasisFn = (_worldPos, camRight, camUp) => ({
    right: [camRight[0], camRight[1], camRight[2]],
    up: [camUp[0], camUp[1], camUp[2]],
});

/** Spherical billboard: faces camera fully. */
export function createFacingBillboardSystem(atlas: SpriteAtlas, opts: BillboardSpriteSystemOptions = {}): BillboardSpriteSystem {
    const system = _createBillboardSystem(atlas, "facing", null, opts);
    system._basisFn = facingBasisFn;
    system._deferredBuild = async (scene): Promise<void> => {
        const mod = await import("./sprite-billboard-facing-renderable.js");
        await mod.buildFacingBillboardRenderable(system, scene);
    };
    return system;
}
