import type { SceneContext } from "./scene-core.js";
import type { ArcRotateCamera } from "../camera/arc-rotate.js";
import { createArcRotateCamera } from "../camera/arc-rotate.js";
import { vec3 } from "../math/vec3-ctor.js";

/** Create an ArcRotateCamera framed to fit all loaded meshes, assign it to scene.
 *  Only the scene knows its contents — auto-framing logic lives here.
 *  Matches Babylon.js createDefaultCameraOrLight(true, true, true). */
export function createDefaultCamera(scene: SceneContext): ArcRotateCamera {
    // Compute world AABB across all meshes with bounds
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;

    for (const m of scene.meshes) {
        const boundMin = m.boundMin;
        const boundMax = m.boundMax;
        if (!boundMin || !boundMax) {
            continue;
        }
        if (m.visible === false) {
            continue;
        }
        if (boundMin[0]! < minX) {
            minX = boundMin[0]!;
        }
        if (boundMin[1]! < minY) {
            minY = boundMin[1]!;
        }
        if (boundMin[2]! < minZ) {
            minZ = boundMin[2]!;
        }
        if (boundMax[0]! > maxX) {
            maxX = boundMax[0]!;
        }
        if (boundMax[1]! > maxY) {
            maxY = boundMax[1]!;
        }
        if (boundMax[2]! > maxZ) {
            maxZ = boundMax[2]!;
        }
    }

    // Babylon formula: radius = worldSize.length() * 1.5
    const sx = maxX - minX,
        sy = maxY - minY,
        sz = maxZ - minZ;
    const diag = Math.sqrt(sx * sx + sy * sy + sz * sz);
    let radius = diag * 1.5;
    let center = vec3(minX + sx * 0.5, minY + sy * 0.5, minZ + sz * 0.5);

    if (!isFinite(radius) || radius === 0) {
        radius = 1;
        center = vec3(0, 0, 0);
    }

    // Babylon defaults: alpha = -π/2, beta = π/2
    const cam = createArcRotateCamera(-(Math.PI / 2), Math.PI / 2, radius, center);
    cam.nearPlane = radius * 0.01;
    cam.farPlane = radius * 1000;

    scene.camera = cam;
    return cam;
}
