/** Compute scene bounds → ground / skybox size (for the background environment). */

import type { SceneContext } from "../../scene/scene.js";
import { emptyWorldAabb, expandWorldAabbForMesh } from "../../mesh/mesh-world-bounds.js";

/** Compute ground size and skybox size from scene bounds.
 *  Matches BJS EnvironmentHelper._setupSizes() with sizeAuto=true.
 *  @param userSkyboxSize - Optional user-provided skyboxSize (BJS still applies
 *                         diagonal override + ×1.5 even for explicit values). */
export function computeSceneSize(
    scene: SceneContext,
    userSkyboxSize?: number
): {
    groundSize: number;
    skyboxSize: number;
    rootPosition: [number, number, number];
} {
    // Object-local bounds through the FULL world matrix (and any thin-instance matrices). This used to add
    // the world translation only, which silently dropped rotation and scale from the environment sizing.
    const acc = emptyWorldAabb();
    for (const m of scene.meshes) {
        expandWorldAabbForMesh(acc, m);
    }
    const minX = acc.minX,
        minY = acc.minY,
        minZ = acc.minZ;
    const maxX = acc.maxX,
        maxY = acc.maxY,
        maxZ = acc.maxZ;

    if (!isFinite(minX)) {
        return { groundSize: 15, skyboxSize: userSkyboxSize ?? 20, rootPosition: [0, 0, 0] };
    }

    const dx = maxX - minX,
        dy = maxY - minY,
        dz = maxZ - minZ;
    const sceneDiagonalLength = Math.sqrt(dx * dx + dy * dy + dz * dz);

    let groundSize = 15;
    let skyboxSize = userSkyboxSize ?? 20;
    const cam = scene.camera;
    if (cam && "upperRadiusLimit" in cam && (cam as { upperRadiusLimit: number }).upperRadiusLimit) {
        groundSize = (cam as { upperRadiusLimit: number }).upperRadiusLimit * 2;
        skyboxSize = groundSize;
    }
    if (sceneDiagonalLength > groundSize) {
        groundSize = sceneDiagonalLength * 2;
        skyboxSize = groundSize;
    }
    groundSize *= 1.1;
    skyboxSize *= 1.5;

    const rootPosition: [number, number, number] = [minX + dx * 0.5, minY - 0.00001, minZ + dz * 0.5];

    return { groundSize, skyboxSize, rootPosition };
}
