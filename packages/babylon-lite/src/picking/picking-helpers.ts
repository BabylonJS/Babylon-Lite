import type { PickingInfo } from "./picking-info.js";
import type { MeshInternal } from "../mesh/mesh.js";

/**
 * Get the interpolated normal at the picked point.
 * Requires detailed picking (faceId >= 0) and mesh._cpuNormals.
 * @param useWorldCoordinates - if true, transform normal by world matrix (default: false)
 */
export function getPickedNormal(info: PickingInfo, useWorldCoordinates = false): [number, number, number] | null {
    const mi = info.pickedMesh as MeshInternal | undefined;
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

    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-10) {
        return [0, 1, 0];
    }
    const invLen = 1 / len;

    const localNormal: [number, number, number] = [nx * invLen, ny * invLen, nz * invLen];
    const wm = mi.worldMatrix;
    const wnx = wm[0]! * localNormal[0] + wm[4]! * localNormal[1] + wm[8]! * localNormal[2];
    const wny = wm[1]! * localNormal[0] + wm[5]! * localNormal[1] + wm[9]! * localNormal[2];
    const wnz = wm[2]! * localNormal[0] + wm[6]! * localNormal[1] + wm[10]! * localNormal[2];
    const wLen = Math.sqrt(wnx * wnx + wny * wny + wnz * wnz);
    const worldNormal: [number, number, number] = wLen < 1e-10 ? [0, 1, 0] : [wnx / wLen, wny / wLen, wnz / wLen];
    const flip = info.ray ? worldNormal[0] * info.ray.direction[0] + worldNormal[1] * info.ray.direction[1] + worldNormal[2] * info.ray.direction[2] > 0 : false;

    if (!useWorldCoordinates) {
        return flip ? [-localNormal[0], -localNormal[1], -localNormal[2]] : localNormal;
    }

    return flip ? [-worldNormal[0], -worldNormal[1], -worldNormal[2]] : worldNormal;
}

/**
 * Get the interpolated UV coordinates at the picked point.
 * Requires detailed picking (faceId >= 0) and mesh._cpuUvs.
 */
export function getPickedUV(info: PickingInfo): [number, number] | null {
    const mi = info.pickedMesh as MeshInternal | undefined;
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
