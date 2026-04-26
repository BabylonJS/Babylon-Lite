/** Compute scene bounds → ground / skybox size (for the background environment). */

import type { SceneContext } from "../../scene/scene.js";

/** Compute ground size and skybox size from scene bounds.
 *  Matches BJS EnvironmentHelper._setupSizes() with sizeAuto=true.
 *  @param userSkyboxSize  Optional user-provided skyboxSize (BJS still applies
 *                         diagonal override + ×1.5 even for explicit values). */
export function computeSceneSize(
    scene: SceneContext,
    userSkyboxSize?: number
): {
    groundSize: number;
    skyboxSize: number;
    rootPosition: [number, number, number];
} {
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    for (const m of scene.meshes) {
        if (!m.boundMin || !m.boundMax) {
            continue;
        }
        const w = m.worldMatrix;
        const tx = w[12]!,
            ty = w[13]!,
            tz = w[14]!;
        const wMinX = m.boundMin[0]! + tx;
        const wMinY = m.boundMin[1]! + ty;
        const wMinZ = m.boundMin[2]! + tz;
        const wMaxX = m.boundMax[0]! + tx;
        const wMaxY = m.boundMax[1]! + ty;
        const wMaxZ = m.boundMax[2]! + tz;
        if (wMinX < minX) {
            minX = wMinX;
        }
        if (wMinY < minY) {
            minY = wMinY;
        }
        if (wMinZ < minZ) {
            minZ = wMinZ;
        }
        if (wMaxX > maxX) {
            maxX = wMaxX;
        }
        if (wMaxY > maxY) {
            maxY = wMaxY;
        }
        if (wMaxZ > maxZ) {
            maxZ = wMaxZ;
        }
    }

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
