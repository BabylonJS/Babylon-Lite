/**
 * Cylindrical (yaw-locked) billboard — sprites rotate only around world Y.
 *
 * Common for trees, NPCs, and chest/banner-style markers that should remain
 * upright as the camera circles. Quad basis is computed in WGSL from
 * `cameraPosition` (packed in `Sprite3DSceneUBO`) and the world-Y axis.
 */

import type { SpriteAtlas } from "./shared/sprite-atlas.js";
import type { BillboardBasisFn, BillboardSpriteSystem, BillboardSpriteSystemOptions } from "./sprite-billboard-shared.js";
import { _createBillboardSystem } from "./sprite-billboard-shared.js";

/** Yaw-locked basis: world-Y is up; right is `cross(up, normalize(camPos - worldPos))`.
 *  Falls back to world-X when the camera is directly overhead/below the sprite. */
const yawBasisFn: BillboardBasisFn = (worldPos, _camRight, _camUp, camPos) => {
    let tx = camPos[0] - worldPos[0];
    let ty = camPos[1] - worldPos[1];
    let tz = camPos[2] - worldPos[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // up = (0,1,0); right = cross(up, toCam) = (tz, 0, -tx)
    let rx = tz;
    let ry = 0;
    let rz = -tx;
    const rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-4) {
        rx = 1;
        ry = 0;
        rz = 0;
    } else {
        rx /= rl;
        ry /= rl;
        rz /= rl;
    }
    return { right: [rx, ry, rz], up: [0, 1, 0] };
};

/** Cylindrical billboard: rotates only around world Y. */
export function createYawLockedBillboardSystem(atlas: SpriteAtlas, opts: BillboardSpriteSystemOptions = {}): BillboardSpriteSystem {
    const system = _createBillboardSystem(atlas, "yaw", null, opts);
    system._basisFn = yawBasisFn;
    system._deferredBuild = async (scene): Promise<void> => {
        const mod = await import("./sprite-billboard-yaw-renderable.js");
        await mod.buildYawLockedBillboardRenderable(system, scene);
    };
    return system;
}
