/**
 * Minimal Path3D — ports just the tangent / normal / binormal / distance
 * computation from `@babylonjs/core/Maths/math.path.ts::Path3D`. Used by
 * `createTube` and `createExtrudeShape`. Always normalized (non-raw).
 *
 * Algorithm: http://www.cs.cmu.edu/afs/andrew/scs/cs/15-462/web/old/asst2camera.html
 */

import type { Vec3 } from "../math/types.js";
import { crossVec3, lengthVec3, normalizeVec3, subVec3, vec3 } from "../math/vec3.js";

const EPSILON = 0.001;

function withinEpsilon(a: number, b: number, eps: number): boolean {
    return Math.abs(a - b) <= eps;
}

function getFirstNonNullVector(curve: Vec3[], index: number): Vec3 {
    let i = 1;
    let v = subVec3(curve[index + i]!, curve[index]!);
    while (lengthVec3(v) === 0 && index + i + 1 < curve.length) {
        i++;
        v = subVec3(curve[index + i]!, curve[index]!);
    }
    return v;
}

function getLastNonNullVector(curve: Vec3[], index: number): Vec3 {
    let i = 1;
    let v = subVec3(curve[index]!, curve[index - i]!);
    while (lengthVec3(v) === 0 && index > i + 1) {
        i++;
        v = subVec3(curve[index]!, curve[index - i]!);
    }
    return v;
}

function normalVector(vt: Vec3, va: Vec3 | null): Vec3 {
    let n: Vec3;
    let tgl = lengthVec3(vt);
    if (tgl === 0) {
        tgl = 1;
    }
    if (va === null) {
        let point: Vec3;
        if (!withinEpsilon(Math.abs(vt.y) / tgl, 1, EPSILON)) {
            point = vec3(0, -1, 0);
        } else if (!withinEpsilon(Math.abs(vt.x) / tgl, 1, EPSILON)) {
            point = vec3(1, 0, 0);
        } else if (!withinEpsilon(Math.abs(vt.z) / tgl, 1, EPSILON)) {
            point = vec3(0, 0, 1);
        } else {
            point = vec3(0, 0, 0);
        }
        n = crossVec3(vt, point);
    } else {
        const c = crossVec3(vt, va);
        n = crossVec3(c, vt);
    }
    return normalizeVec3(n);
}

export interface Path3D {
    tangents: Vec3[];
    normals: Vec3[];
    binormals: Vec3[];
    distances: number[];
}

export function computePath3D(curve: Vec3[], firstNormal: Vec3 | null = null): Path3D {
    const l = curve.length;
    const tangents: Vec3[] = new Array(l);
    const normals: Vec3[] = new Array(l);
    const binormals: Vec3[] = new Array(l);
    const distances: number[] = new Array(l);

    if (l < 2) {
        return { tangents, normals, binormals, distances };
    }

    tangents[0] = normalizeVec3(getFirstNonNullVector(curve, 0));
    tangents[l - 1] = normalizeVec3(subVec3(curve[l - 1]!, curve[l - 2]!));

    const pp0 = normalizeVec3(normalVector(tangents[0]!, firstNormal));
    normals[0] = pp0;
    binormals[0] = normalizeVec3(crossVec3(tangents[0]!, normals[0]!));
    distances[0] = 0;

    for (let i = 1; i < l; i++) {
        const prev = getLastNonNullVector(curve, i);
        if (i < l - 1) {
            const cur = getFirstNonNullVector(curve, i);
            const sum = { x: prev.x + cur.x, y: prev.y + cur.y, z: prev.z + cur.z };
            tangents[i] = normalizeVec3(sum);
        }
        distances[i] = distances[i - 1]! + lengthVec3(subVec3(curve[i]!, curve[i - 1]!));

        const curTang = tangents[i]!;
        const prevBinor = binormals[i - 1]!;
        let n = crossVec3(prevBinor, curTang);
        if (lengthVec3(n) === 0) {
            const prevN = normals[i - 1]!;
            n = { x: prevN.x, y: prevN.y, z: prevN.z };
        } else {
            n = normalizeVec3(n);
        }
        normals[i] = n;
        binormals[i] = normalizeVec3(crossVec3(curTang, n));
    }

    return { tangents, normals, binormals, distances };
}
