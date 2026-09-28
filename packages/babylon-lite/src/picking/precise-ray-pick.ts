import { allocateMat4Storage } from "../math/_matrix-allocator.js";
import { invertMat4 } from "../math/invert-mat4.js";
import { multiplyMat4 } from "../math/multiply-mat4.js";
import { normalizeVec3TupleOrUp } from "../math/normalize-vec3-tuple-or-up.js";
import type { Mat4 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneContext } from "../scene/scene.js";
import { createEmptyPickingInfo, type PickingInfo } from "./picking-info.js";
import type { Ray } from "./ray.js";

type Point3 = readonly [number, number, number];
const PICK_EPSILON = 0.001;

/** Decide whether a triangle participates in a precise ray pick. */
export type TrianglePickingPredicate = (p0: Point3, p1: Point3, p2: Point3, ray: Ray, i0: number, i1: number, i2: number) => boolean;

/** Options for the opt-in triangle-precise synchronous picker. */
export interface PreciseRayPickOptions {
    /** Return `true` for a mesh instance that may be picked. `thinInstanceIndex` is
     *  `-1` for an ordinary mesh. */
    predicate?: (mesh: Mesh, thinInstanceIndex: number) => boolean;
    /** Skip Lite's default `pickable === false` exclusion. */
    skipPickableCheck?: boolean;
    /** Return the first triangle hit instead of searching for the nearest hit. */
    fastCheck?: boolean;
    /** Return `true` for a triangle that may be picked. Coordinates and ray are mesh-local. */
    trianglePredicate?: TrianglePickingPredicate;
}

interface TriangleHit {
    distance: number;
    faceId: number;
    bu: number;
    bv: number;
}

function transformPoint(matrix: Mat4, point: Point3): [number, number, number] {
    const x = point[0];
    const y = point[1];
    const z = point[2];
    const w = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
    const inverseW = w !== 0 ? 1 / w : 1;
    return [
        (matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!) * inverseW,
        (matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!) * inverseW,
        (matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!) * inverseW,
    ];
}

function transformDirection(matrix: Mat4, direction: Point3): [number, number, number] {
    const x = direction[0];
    const y = direction[1];
    const z = direction[2];
    return [matrix[0]! * x + matrix[4]! * y + matrix[8]! * z, matrix[1]! * x + matrix[5]! * y + matrix[9]! * z, matrix[2]! * x + matrix[6]! * y + matrix[10]! * z];
}

function intersectsBounds(positions: Float32Array, ray: Ray, maxDistance: number): boolean {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        minX = Math.min(minX, positions[i]!);
        minY = Math.min(minY, positions[i + 1]!);
        minZ = Math.min(minZ, positions[i + 2]!);
        maxX = Math.max(maxX, positions[i]!);
        maxY = Math.max(maxY, positions[i + 1]!);
        maxZ = Math.max(maxZ, positions[i + 2]!);
    }

    let minimum = 0;
    let maximum = maxDistance;
    for (let axis = 0; axis < 3; axis++) {
        const origin = ray.origin[axis]!;
        const direction = ray.direction[axis]!;
        const lower = axis === 0 ? minX : axis === 1 ? minY : minZ;
        const upper = axis === 0 ? maxX : axis === 1 ? maxY : maxZ;
        if (Math.abs(direction) < 1e-12) {
            if (origin < lower || origin > upper) {
                return false;
            }
            continue;
        }
        let near = (lower - origin) / direction;
        let far = (upper - origin) / direction;
        if (near > far) {
            [near, far] = [far, near];
        }
        minimum = Math.max(minimum, near);
        maximum = Math.min(maximum, far);
        if (minimum > maximum) {
            return false;
        }
    }
    return true;
}

function intersectTriangle(ray: Ray, p0: Point3, p1: Point3, p2: Point3, maxDistance: number): { distance: number; bu: number; bv: number } | null {
    const e1x = p1[0] - p0[0];
    const e1y = p1[1] - p0[1];
    const e1z = p1[2] - p0[2];
    const e2x = p2[0] - p0[0];
    const e2y = p2[1] - p0[1];
    const e2z = p2[2] - p0[2];
    const px = ray.direction[1] * e2z - ray.direction[2] * e2y;
    const py = ray.direction[2] * e2x - ray.direction[0] * e2z;
    const pz = ray.direction[0] * e2y - ray.direction[1] * e2x;
    const determinant = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(determinant) < 1e-12) {
        return null;
    }

    const inverseDeterminant = 1 / determinant;
    const tx = ray.origin[0] - p0[0];
    const ty = ray.origin[1] - p0[1];
    const tz = ray.origin[2] - p0[2];
    const vertex1Weight = (tx * px + ty * py + tz * pz) * inverseDeterminant;
    if (vertex1Weight < -PICK_EPSILON || vertex1Weight > 1 + PICK_EPSILON) {
        return null;
    }

    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const vertex2Weight = (ray.direction[0] * qx + ray.direction[1] * qy + ray.direction[2] * qz) * inverseDeterminant;
    if (vertex2Weight < -PICK_EPSILON || vertex1Weight + vertex2Weight > 1 + PICK_EPSILON) {
        return null;
    }

    const distance = (e2x * qx + e2y * qy + e2z * qz) * inverseDeterminant;
    if (distance < 0 || distance > maxDistance) {
        return null;
    }
    return { distance, bu: 1 - vertex1Weight - vertex2Weight, bv: vertex1Weight };
}

function pickMeshTriangles(mesh: Mesh, localRay: Ray, directionScale: number, maxDistance: number, options: PreciseRayPickOptions): TriangleHit | null {
    const positions = mesh._cpuPositions;
    const indices = mesh._cpuIndices;
    if (!positions || positions.length < 3 || !indices || indices.length < 3 || mesh._topology || mesh.skeleton || mesh.morphTargets || mesh.vat) {
        return null;
    }
    if (!intersectsBounds(positions, localRay, maxDistance * directionScale)) {
        return null;
    }

    let best: TriangleHit | null = null;
    for (let offset = 0; offset + 2 < indices.length; offset += 3) {
        const i0 = indices[offset]!;
        const i1 = indices[offset + 1]!;
        const i2 = indices[offset + 2]!;
        if (i0 * 3 + 2 >= positions.length || i1 * 3 + 2 >= positions.length || i2 * 3 + 2 >= positions.length) {
            continue;
        }
        const p0: Point3 = [positions[i0 * 3]!, positions[i0 * 3 + 1]!, positions[i0 * 3 + 2]!];
        const p1: Point3 = [positions[i1 * 3]!, positions[i1 * 3 + 1]!, positions[i1 * 3 + 2]!];
        const p2: Point3 = [positions[i2 * 3]!, positions[i2 * 3 + 1]!, positions[i2 * 3 + 2]!];
        if (options.trianglePredicate && !options.trianglePredicate(p0, p1, p2, localRay, i0, i1, i2)) {
            continue;
        }
        const hit = intersectTriangle(localRay, p0, p1, p2, (best?.distance ?? maxDistance) * directionScale);
        if (!hit) {
            continue;
        }
        best = { distance: hit.distance / directionScale, faceId: offset / 3, bu: hit.bu, bv: hit.bv };
        if (options.fastCheck) {
            return best;
        }
    }
    return best;
}

function instanceWorldMatrix(mesh: Mesh, thinInstanceIndex: number): Mat4 {
    if (thinInstanceIndex < 0 || !mesh.thinInstances) {
        return mesh.worldMatrix;
    }
    const offset = thinInstanceIndex * 16;
    const instance = allocateMat4Storage();
    for (let index = 0; index < 16; index++) {
        instance[index] = mesh.thinInstances.matrices[offset + index]!;
    }
    instance[3] = 0;
    instance[7] = 0;
    instance[11] = 0;
    instance[15] = 1;
    return multiplyMat4(mesh.worldMatrix, instance as unknown as Mat4);
}

function transformNormal(matrix: Mat4, normal: Point3): [number, number, number] {
    return [
        matrix[0]! * normal[0] + matrix[4]! * normal[1] + matrix[8]! * normal[2],
        matrix[1]! * normal[0] + matrix[5]! * normal[1] + matrix[9]! * normal[2],
        matrix[2]! * normal[0] + matrix[6]! * normal[1] + matrix[10]! * normal[2],
    ];
}

function hasNonUniformScaling(matrix: Mat4): boolean {
    const scaleX = Math.hypot(matrix[0]!, matrix[1]!, matrix[2]!);
    const scaleY = Math.hypot(matrix[4]!, matrix[5]!, matrix[6]!);
    const scaleZ = Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!);
    return Math.abs(scaleX - scaleY) > 1e-6 || Math.abs(scaleX - scaleZ) > 1e-6;
}

function normalToWorld(mesh: Mesh, thinInstanceIndex: number, normal: Point3): [number, number, number] {
    let transformed: Point3 = normal;
    if (thinInstanceIndex >= 0 && mesh.thinInstances) {
        const offset = thinInstanceIndex * 16;
        const matrix = mesh.thinInstances.matrices.subarray(offset, offset + 16) as unknown as Mat4;
        transformed = transformNormal(matrix, transformed);
    }
    if (hasNonUniformScaling(mesh.worldMatrix)) {
        const inverseWorld = invertMat4(mesh.worldMatrix);
        if (inverseWorld) {
            return normalizeVec3TupleOrUp(
                inverseWorld[0]! * transformed[0] + inverseWorld[1]! * transformed[1] + inverseWorld[2]! * transformed[2],
                inverseWorld[4]! * transformed[0] + inverseWorld[5]! * transformed[1] + inverseWorld[6]! * transformed[2],
                inverseWorld[8]! * transformed[0] + inverseWorld[9]! * transformed[1] + inverseWorld[10]! * transformed[2]
            );
        }
    }
    transformed = transformNormal(mesh.worldMatrix, transformed);
    return normalizeVec3TupleOrUp(transformed[0], transformed[1], transformed[2]);
}

function populateSurfaceDetail(info: PickingInfo, mesh: Mesh, thinInstanceIndex: number, hit: TriangleHit): void {
    const positions = mesh._cpuPositions!;
    const indices = mesh._cpuIndices!;
    const i0 = indices[hit.faceId * 3]!;
    const i1 = indices[hit.faceId * 3 + 1]!;
    const i2 = indices[hit.faceId * 3 + 2]!;
    info.faceId = hit.faceId;
    info.bu = hit.bu;
    info.bv = hit.bv;

    const normals = mesh._cpuNormals;
    if (normals && i0 * 3 + 2 < normals.length && i1 * 3 + 2 < normals.length && i2 * 3 + 2 < normals.length) {
        const remainder = 1 - hit.bu - hit.bv;
        let localNormal = normalizeVec3TupleOrUp(
            hit.bu * normals[i0 * 3]! + hit.bv * normals[i1 * 3]! + remainder * normals[i2 * 3]!,
            hit.bu * normals[i0 * 3 + 1]! + hit.bv * normals[i1 * 3 + 1]! + remainder * normals[i2 * 3 + 1]!,
            hit.bu * normals[i0 * 3 + 2]! + hit.bv * normals[i1 * 3 + 2]! + remainder * normals[i2 * 3 + 2]!
        );
        let worldNormal = normalToWorld(mesh, thinInstanceIndex, localNormal);
        if (info.ray && worldNormal[0] * info.ray.direction[0] + worldNormal[1] * info.ray.direction[1] + worldNormal[2] * info.ray.direction[2] > 0) {
            localNormal = [-localNormal[0], -localNormal[1], -localNormal[2]];
            worldNormal = [-worldNormal[0], -worldNormal[1], -worldNormal[2]];
        }
        info.pickedNormal = localNormal;
        info.pickedNormalWorld = worldNormal;
    }

    const e1x = positions[i1 * 3]! - positions[i0 * 3]!;
    const e1y = positions[i1 * 3 + 1]! - positions[i0 * 3 + 1]!;
    const e1z = positions[i1 * 3 + 2]! - positions[i0 * 3 + 2]!;
    const e2x = positions[i2 * 3]! - positions[i0 * 3]!;
    const e2y = positions[i2 * 3 + 1]! - positions[i0 * 3 + 1]!;
    const e2z = positions[i2 * 3 + 2]! - positions[i0 * 3 + 2]!;
    let localFaceNormal = normalizeVec3TupleOrUp(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
    let worldFaceNormal = normalToWorld(mesh, thinInstanceIndex, localFaceNormal);
    if (info.ray && worldFaceNormal[0] * info.ray.direction[0] + worldFaceNormal[1] * info.ray.direction[1] + worldFaceNormal[2] * info.ray.direction[2] > 0) {
        localFaceNormal = [-localFaceNormal[0], -localFaceNormal[1], -localFaceNormal[2]];
        worldFaceNormal = [-worldFaceNormal[0], -worldFaceNormal[1], -worldFaceNormal[2]];
    }
    info.pickedFaceNormal = localFaceNormal;
    info.pickedFaceNormalWorld = worldFaceNormal;
}

function populateHit(info: PickingInfo, mesh: Mesh, thinInstanceIndex: number, hit: TriangleHit): PickingInfo {
    const ray = info.ray!;
    info.hit = true;
    info.distance = hit.distance;
    info.pickedMesh = mesh;
    info.pickedPoint = [ray.origin[0] + ray.direction[0] * hit.distance, ray.origin[1] + ray.direction[1] * hit.distance, ray.origin[2] + ray.direction[2] * hit.distance];
    info.thinInstanceIndex = thinInstanceIndex;
    populateSurfaceDetail(info, mesh, thinInstanceIndex, hit);
    return info;
}

/** Triangle-precise synchronous ray pick over an explicit mesh collection.
 *
 * This opt-in path uses retained CPU geometry. Actively skinned, morphed, or
 * vertex-animated meshes are skipped because their rendered positions are not
 * synchronously available; use GPU picking for those meshes.
 */
export function pickMeshesWithRayPrecise(meshes: Iterable<Mesh>, ray: Ray, options: PreciseRayPickOptions = {}): PickingInfo {
    const info = createEmptyPickingInfo();
    info.ray = ray;
    let bestDistance = ray.length;
    let bestMesh: Mesh | null = null;
    let bestThinInstanceIndex = -1;
    let bestHit: TriangleHit | null = null;

    for (const mesh of meshes) {
        if (!options.skipPickableCheck && mesh.pickable === false) {
            continue;
        }
        if (options.predicate && !options.predicate(mesh, -1)) {
            continue;
        }
        const instanceCount = mesh.thinInstances ? Math.min(mesh.thinInstances.count, Math.floor(mesh.thinInstances.matrices.length / 16)) : 0;
        const firstInstance = instanceCount > 0 ? 0 : -1;
        for (let thinInstanceIndex = firstInstance; thinInstanceIndex < instanceCount; thinInstanceIndex++) {
            if (thinInstanceIndex >= 0 && options.predicate && !options.predicate(mesh, thinInstanceIndex)) {
                continue;
            }
            const world = instanceWorldMatrix(mesh, thinInstanceIndex);
            const inverseWorld = invertMat4(world);
            if (!inverseWorld) {
                continue;
            }
            const localDirection = transformDirection(inverseWorld, ray.direction);
            const directionScale = Math.hypot(localDirection[0], localDirection[1], localDirection[2]);
            if (directionScale < 1e-12) {
                continue;
            }
            const localRay: Ray = {
                origin: transformPoint(inverseWorld, ray.origin),
                direction: [localDirection[0] / directionScale, localDirection[1] / directionScale, localDirection[2] / directionScale],
                length: ray.length * directionScale,
            };
            const hit = pickMeshTriangles(mesh, localRay, directionScale, bestDistance, options);
            if (!hit) {
                continue;
            }
            if (options.fastCheck) {
                return populateHit(info, mesh, thinInstanceIndex, hit);
            }
            bestDistance = hit.distance;
            bestMesh = mesh;
            bestThinInstanceIndex = thinInstanceIndex;
            bestHit = hit;
        }
    }

    return bestMesh && bestHit ? populateHit(info, bestMesh, bestThinInstanceIndex, bestHit) : info;
}

/** Triangle-precise synchronous ray pick over a scene's meshes. */
export function pickWithRayPrecise(scene: SceneContext, ray: Ray, options?: PreciseRayPickOptions): PickingInfo {
    return pickMeshesWithRayPrecise(scene.meshes, ray, options);
}
