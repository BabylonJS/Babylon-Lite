import type { PickingInfo } from "./picking-info.js";
import type { Mesh } from "../mesh/mesh.js";
import { normalizeVec3 } from "../math/normalize-vec3.js";

/**
 * Get the interpolated normal at the picked point.
 * Requires detailed picking (`faceId >= 0`) and mesh._cpuNormals.
 * @param useWorldCoordinates - if true, transform normal by world matrix (default: false)
 */
export function getPickedNormal(info: PickingInfo, useWorldCoordinates = false): [number, number, number] | null {
    if (useWorldCoordinates && info.pickedNormalWorld) {
        return info.pickedNormalWorld;
    }
    if (!useWorldCoordinates && info.pickedNormal) {
        return info.pickedNormal;
    }

    const mi = info.pickedMesh as Mesh | undefined;
    if (info.faceId < 0 || !mi || !mi._cpuNormals || !mi._cpuIndices) {
        return null;
    }

    const normals = mi._cpuNormals;
    const indices = mi._cpuIndices;
    const face = info.faceId;

    const i0 = indices[face * 3]!;
    const i1 = indices[face * 3 + 1]!;
    const i2 = indices[face * 3 + 2]!;

    // BJS exposes bu for vertex 0 and bv for vertex 1; vertex 2 gets the remainder.
    const bw = 1 - info.bu - info.bv;
    const nx = info.bu * normals[i0 * 3]! + info.bv * normals[i1 * 3]! + bw * normals[i2 * 3]!;
    const ny = info.bu * normals[i0 * 3 + 1]! + info.bv * normals[i1 * 3 + 1]! + bw * normals[i2 * 3 + 1]!;
    const nz = info.bu * normals[i0 * 3 + 2]! + info.bv * normals[i1 * 3 + 2]! + bw * normals[i2 * 3 + 2]!;

    const localNormal = normalizeVec3(nx, ny, nz);
    const wm = mi.worldMatrix;
    const wnx = wm[0]! * localNormal[0] + wm[4]! * localNormal[1] + wm[8]! * localNormal[2];
    const wny = wm[1]! * localNormal[0] + wm[5]! * localNormal[1] + wm[9]! * localNormal[2];
    const wnz = wm[2]! * localNormal[0] + wm[6]! * localNormal[1] + wm[10]! * localNormal[2];
    const worldNormal = normalizeVec3(wnx, wny, wnz);
    const flip = info.ray ? worldNormal[0] * info.ray.direction[0] + worldNormal[1] * info.ray.direction[1] + worldNormal[2] * info.ray.direction[2] > 0 : false;

    if (!useWorldCoordinates) {
        return flip ? [-localNormal[0], -localNormal[1], -localNormal[2]] : localNormal;
    }

    return flip ? [-worldNormal[0], -worldNormal[1], -worldNormal[2]] : worldNormal;
}

export function getPickedFaceNormal(info: PickingInfo, useWorldCoordinates = false): [number, number, number] | null {
    if (useWorldCoordinates) {
        return info.pickedFaceNormalWorld;
    }
    return info.pickedFaceNormal;
}

/**
 * Get the interpolated UV coordinates at the picked point.
 * Requires detailed picking (`faceId >= 0`) and mesh._cpuUvs.
 */
export function getPickedUV(info: PickingInfo): [number, number] | null {
    const mi = info.pickedMesh as Mesh | undefined;
    if (info.faceId < 0 || !mi || !mi._cpuUvs || !mi._cpuIndices) {
        return null;
    }

    const uvs = mi._cpuUvs;
    const indices = mi._cpuIndices;
    const face = info.faceId;

    const i0 = indices[face * 3]!;
    const i1 = indices[face * 3 + 1]!;
    const i2 = indices[face * 3 + 2]!;

    const bw = 1 - info.bu - info.bv;
    const u = info.bu * uvs[i0 * 2]! + info.bv * uvs[i1 * 2]! + bw * uvs[i2 * 2]!;
    const v = info.bu * uvs[i0 * 2 + 1]! + info.bv * uvs[i1 * 2 + 1]! + bw * uvs[i2 * 2 + 1]!;

    return [u, v];
}
