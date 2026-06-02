import type { Mat4 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import type { GpuPicker } from "./gpu-picker.js";
import type { PickingInfo } from "./picking-info.js";
import type { Ray } from "./ray.js";
import { normalizeVec3 } from "../math/normalize-vec3.js";
import { computeDeformedPositions } from "./deformed-geometry.js";

/**
 * Enable detailed picking on a GPU picker.
 * When enabled, pickAsync() will compute faceId, bu, bv
 * by performing CPU ray-triangle intersection on the identified mesh.
 * Requires meshes to have _cpuPositions and _cpuIndices set.
 */
export function enableDetailedPicking(picker: GpuPicker): void {
    picker._detailedPick = detailedPick;
}

async function detailedPick(info: PickingInfo, ray: Ray): Promise<void> {
    const mesh = info.pickedMesh;
    const mi = mesh as Mesh | null;
    if (!mi || !mi._cpuPositions || !mi._cpuIndices) {
        return;
    }

    const deformedPositions = hasCpuDeformationData(mi) ? computeDeformedPositions(mi) : null;
    const positions = deformedPositions ?? mi._cpuPositions;
    const normals = mi._cpuNormals;
    const indices = mi._cpuIndices;

    // Determine the world matrix — use thin instance matrix when applicable
    let worldMatrix: Mat4 = mi.worldMatrix;
    if (info.thinInstanceIndex >= 0 && mi.thinInstances) {
        const offset = info.thinInstanceIndex * 16;
        worldMatrix = mi.thinInstances.matrices.subarray(offset, offset + 16) as unknown as Mat4;
    }

    const triCount = indices.length / 3;
    let closestT = Infinity;
    let closestFace = -1;
    let closestBu = 0;
    let closestBv = 0;

    for (let i = 0; i < triCount; i++) {
        const i0 = indices[i * 3]!;
        const i1 = indices[i * 3 + 1]!;
        const i2 = indices[i * 3 + 2]!;

        // Get vertex positions
        const ax = positions[i0 * 3]!,
            ay = positions[i0 * 3 + 1]!,
            az = positions[i0 * 3 + 2]!;
        const bx = positions[i1 * 3]!,
            by = positions[i1 * 3 + 1]!,
            bz = positions[i1 * 3 + 2]!;
        const cx = positions[i2 * 3]!,
            cy = positions[i2 * 3 + 1]!,
            cz = positions[i2 * 3 + 2]!;

        // Transform to world space using worldMatrix (column-major 4x4)
        const wax = worldMatrix[0]! * ax + worldMatrix[4]! * ay + worldMatrix[8]! * az + worldMatrix[12]!;
        const way = worldMatrix[1]! * ax + worldMatrix[5]! * ay + worldMatrix[9]! * az + worldMatrix[13]!;
        const waz = worldMatrix[2]! * ax + worldMatrix[6]! * ay + worldMatrix[10]! * az + worldMatrix[14]!;

        const wbx = worldMatrix[0]! * bx + worldMatrix[4]! * by + worldMatrix[8]! * bz + worldMatrix[12]!;
        const wby = worldMatrix[1]! * bx + worldMatrix[5]! * by + worldMatrix[9]! * bz + worldMatrix[13]!;
        const wbz = worldMatrix[2]! * bx + worldMatrix[6]! * by + worldMatrix[10]! * bz + worldMatrix[14]!;

        const wcx = worldMatrix[0]! * cx + worldMatrix[4]! * cy + worldMatrix[8]! * cz + worldMatrix[12]!;
        const wcy = worldMatrix[1]! * cx + worldMatrix[5]! * cy + worldMatrix[9]! * cz + worldMatrix[13]!;
        const wcz = worldMatrix[2]! * cx + worldMatrix[6]! * cy + worldMatrix[10]! * cz + worldMatrix[14]!;

        // Möller–Trumbore ray-triangle intersection
        const result = rayTriangleIntersect(
            ray.origin[0],
            ray.origin[1],
            ray.origin[2],
            ray.direction[0],
            ray.direction[1],
            ray.direction[2],
            ray.length,
            wax,
            way,
            waz,
            wbx,
            wby,
            wbz,
            wcx,
            wcy,
            wcz
        );

        if (result && result.t > 0 && result.t < closestT) {
            closestT = result.t;
            closestFace = i;
            closestBu = result.u;
            closestBv = result.v;
        }
    }

    if (closestFace >= 0) {
        const bjsBu = clampBarycentric(1 - closestBu - closestBv);
        info.faceId = closestFace;
        info.bu = bjsBu;
        info.bv = clampBarycentric(closestBu);
        info.distance = closestT;
        info.pickedPoint = [ray.origin[0] + ray.direction[0] * closestT, ray.origin[1] + ray.direction[1] * closestT, ray.origin[2] + ray.direction[2] * closestT];
        if (normals) {
            const i0 = indices[closestFace * 3]!;
            const i1 = indices[closestFace * 3 + 1]!;
            const i2 = indices[closestFace * 3 + 2]!;
            const bw = 1 - info.bu - info.bv;
            const localNormal = normalizeVec3(
                info.bu * normals[i0 * 3]! + info.bv * normals[i1 * 3]! + bw * normals[i2 * 3]!,
                info.bu * normals[i0 * 3 + 1]! + info.bv * normals[i1 * 3 + 1]! + bw * normals[i2 * 3 + 1]!,
                info.bu * normals[i0 * 3 + 2]! + info.bv * normals[i1 * 3 + 2]! + bw * normals[i2 * 3 + 2]!
            );
            const worldNormal = normalizeVec3(
                worldMatrix[0]! * localNormal[0] + worldMatrix[4]! * localNormal[1] + worldMatrix[8]! * localNormal[2],
                worldMatrix[1]! * localNormal[0] + worldMatrix[5]! * localNormal[1] + worldMatrix[9]! * localNormal[2],
                worldMatrix[2]! * localNormal[0] + worldMatrix[6]! * localNormal[1] + worldMatrix[10]! * localNormal[2]
            );
            const flip = worldNormal[0] * ray.direction[0] + worldNormal[1] * ray.direction[1] + worldNormal[2] * ray.direction[2] > 0;
            info.pickedNormal = flip ? [-localNormal[0], -localNormal[1], -localNormal[2]] : localNormal;
            info.pickedNormalWorld = flip ? [-worldNormal[0], -worldNormal[1], -worldNormal[2]] : worldNormal;
        }

        const i0 = indices[closestFace * 3]!;
        const i1 = indices[closestFace * 3 + 1]!;
        const i2 = indices[closestFace * 3 + 2]!;
        const ax = positions[i0 * 3]!;
        const ay = positions[i0 * 3 + 1]!;
        const az = positions[i0 * 3 + 2]!;
        const bx = positions[i1 * 3]!;
        const by = positions[i1 * 3 + 1]!;
        const bz = positions[i1 * 3 + 2]!;
        const cx = positions[i2 * 3]!;
        const cy = positions[i2 * 3 + 1]!;
        const cz = positions[i2 * 3 + 2]!;
        const faceNormal = normalizeVec3(
            (by - ay) * (cz - az) - (bz - az) * (cy - ay),
            (bz - az) * (cx - ax) - (bx - ax) * (cz - az),
            (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
        );
        const faceWorldNormal = normalizeVec3(
            worldMatrix[0]! * faceNormal[0] + worldMatrix[4]! * faceNormal[1] + worldMatrix[8]! * faceNormal[2],
            worldMatrix[1]! * faceNormal[0] + worldMatrix[5]! * faceNormal[1] + worldMatrix[9]! * faceNormal[2],
            worldMatrix[2]! * faceNormal[0] + worldMatrix[6]! * faceNormal[1] + worldMatrix[10]! * faceNormal[2]
        );
        const flip = faceWorldNormal[0] * ray.direction[0] + faceWorldNormal[1] * ray.direction[1] + faceWorldNormal[2] * ray.direction[2] > 0;
        info.pickedFaceNormal = flip ? [-faceNormal[0], -faceNormal[1], -faceNormal[2]] : faceNormal;
        info.pickedFaceNormalWorld = flip ? [-faceWorldNormal[0], -faceWorldNormal[1], -faceWorldNormal[2]] : faceWorldNormal;
    }
}

function clampBarycentric(value: number): number {
    return Math.abs(value) < 1e-12 ? 0 : value;
}

function hasCpuDeformationData(mesh: Mesh): boolean {
    const morph = mesh.morphTargets;
    const skeleton = mesh.skeleton;
    return (!!morph?.targets && !!morph.weights) || (!!skeleton?.boneMatrices && !!skeleton.joints && !!skeleton.weights);
}

/** Möller-Trumbore ray-triangle intersection with Babylon.js Ray epsilon semantics.
 *  Returns `{ t, u, v }` or null if no intersection.
 *  u and v are Möller weights for vertices 1 and 2; BJS exposes (1 - u - v, u). */
function rayTriangleIntersect(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    length: number,
    v0x: number,
    v0y: number,
    v0z: number,
    v1x: number,
    v1y: number,
    v1z: number,
    v2x: number,
    v2y: number,
    v2z: number
): { t: number; u: number; v: number } | null {
    const EPSILON = 0.001;

    // edge1 = v1 - v0, edge2 = v2 - v0
    const e1x = v1x - v0x,
        e1y = v1y - v0y,
        e1z = v1z - v0z;
    const e2x = v2x - v0x,
        e2y = v2y - v0y,
        e2z = v2z - v0z;

    // h = cross(direction, edge2)
    const hx = dy * e2z - dz * e2y;
    const hy = dz * e2x - dx * e2z;
    const hz = dx * e2y - dy * e2x;

    const det = e1x * hx + e1y * hy + e1z * hz;
    if (det === 0) {
        return null; // parallel
    }

    const invDet = 1 / det;

    // s = origin - v0
    const sx = ox - v0x,
        sy = oy - v0y,
        sz = oz - v0z;

    const u = (sx * hx + sy * hy + sz * hz) * invDet;
    if (u < -EPSILON || u > 1 + EPSILON) {
        return null;
    }

    // q = cross(s, edge1)
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;

    const v = (dx * qx + dy * qy + dz * qz) * invDet;
    if (v < -EPSILON || u + v > 1 + EPSILON) {
        return null;
    }

    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    if (t > length || t < 0) {
        return null; // behind ray
    }

    return { t, u, v };
}
