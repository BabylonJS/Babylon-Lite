/** Parse a FreeCamera from .babylon camera data. Dynamically imported by load-babylon.ts. */
import { createFreeCamera } from "../camera/free-camera.js";
import type { FreeCamera } from "../camera/free-camera.js";
import { _rightHanded } from "#coordinate-system";

export function parseBabylonCamera(cd: { position: number[]; rotation?: number[]; fov?: number; minZ?: number; maxZ?: number }): FreeCamera {
    const p = cd.position;
    const pitch = cd.rotation?.[0] ?? 0;
    const yaw = cd.rotation?.[1] ?? 0;
    const cp = Math.cos(pitch);
    // Babylon.js turns a camera's local forward axis by its rotation: +Z in a left-handed engine, -Z in a right-handed one.
    const cam = createFreeCamera(
        { x: p[0]!, y: p[1]!, z: p[2]! },
        _rightHanded
            ? { x: p[0]! - cp * Math.sin(yaw), y: p[1]! + Math.sin(pitch), z: p[2]! - cp * Math.cos(yaw) }
            : { x: p[0]! + cp * Math.sin(yaw), y: p[1]! - Math.sin(pitch), z: p[2]! + cp * Math.cos(yaw) }
    );
    if (cd.fov != null) {
        cam.fov = cd.fov;
    }
    if (cd.minZ != null) {
        cam.nearPlane = cd.minZ;
    }
    if (cd.maxZ != null) {
        cam.farPlane = cd.maxZ;
    }
    return cam;
}
