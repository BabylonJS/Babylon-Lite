/**
 * Ray-casting helpers — screen-to-world ray construction and intersection
 * tests for pointer interaction with world-space geometry.
 *
 * Babylon Lite uses column-major matrices and reverse-Z projection
 * (near → 1, far → 0 in NDC).
 */

import type { SceneContext } from "babylon-lite";
import { getViewProjectionMatrix } from "babylon-lite";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Ray {
    origin: [number, number, number];
    dir: [number, number, number];
}

export interface AABB {
    readonly minX: number;
    readonly minY: number;
    readonly minZ: number;
    readonly maxX: number;
    readonly maxY: number;
    readonly maxZ: number;
}

// ─── Matrix inverse ──────────────────────────────────────────────────────────

/** 4×4 matrix inverse (cofactor expansion). */
function invertMat4(m: ArrayLike<number>): Float32Array | null {
    const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!;
    const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!;
    const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!;
    const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!;

    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (Math.abs(det) < 1e-10) {
        return null;
    }
    det = 1 / det;

    const out = new Float32Array(16);
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
}

// ─── Unprojection ────────────────────────────────────────────────────────────

function unproject(invVP: Float32Array, ndcX: number, ndcY: number, depth: number): [number, number, number] {
    const x = invVP[0]! * ndcX + invVP[4]! * ndcY + invVP[8]! * depth + invVP[12]!;
    const y = invVP[1]! * ndcX + invVP[5]! * ndcY + invVP[9]! * depth + invVP[13]!;
    const z = invVP[2]! * ndcX + invVP[6]! * ndcY + invVP[10]! * depth + invVP[14]!;
    const w = invVP[3]! * ndcX + invVP[7]! * ndcY + invVP[11]! * depth + invVP[15]!;
    const inv = 1 / w;
    return [x * inv, y * inv, z * inv];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Build a world-space ray from CSS-pixel coordinates on the canvas. */
export function screenRay(
    cssX: number,
    cssY: number,
    scene: SceneContext,
    canvas: HTMLCanvasElement,
): Ray | null {
    const cam = scene.camera;
    if (!cam) {
        return null;
    }
    const canvasW = canvas.width || 1;
    const canvasH = canvas.height || 1;
    const vpMatrix = getViewProjectionMatrix(cam, canvasW / canvasH);
    const invVP = invertMat4(vpMatrix);
    if (!invVP) {
        return null;
    }

    const cssW = canvas.clientWidth || canvasW;
    const dpr = canvasW / cssW;
    const px = cssX * dpr;
    const py = cssY * dpr;

    const ndcX = (2 * px) / canvasW - 1;
    const ndcY = 1 - (2 * py) / canvasH;

    // Reverse-Z: near = 1, far = 0
    const near = unproject(invVP, ndcX, ndcY, 1);
    const far = unproject(invVP, ndcX, ndcY, 0);

    const dx = far[0] - near[0];
    const dy = far[1] - near[1];
    const dz = far[2] - near[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-10) {
        return null;
    }
    const inv = 1 / len;
    return { origin: near, dir: [dx * inv, dy * inv, dz * inv] };
}

/**
 * Box face identifiers:
 * right = +X, left = -X, top = +Y, bottom = -Y, back = +Z, front = -Z.
 */
export type FaceId = "right" | "left" | "top" | "bottom" | "back" | "front";

const FACE_BY_AXIS: readonly (readonly [FaceId, FaceId])[] = [
    ["left", "right"], // X: entering through minX face ("left") when dir.x > 0
    ["bottom", "top"], // Y
    ["front", "back"], // Z
];

/** Outward unit normal for each face. */
export const FACE_NORMALS: Readonly<Record<FaceId, readonly [number, number, number]>> = {
    right: [1, 0, 0],
    left: [-1, 0, 0],
    top: [0, 1, 0],
    bottom: [0, -1, 0],
    back: [0, 0, 1],
    front: [0, 0, -1],
};

export interface RayFaceHit {
    /** Distance along the ray to the hit point (≥ 0). */
    readonly t: number;
    /** The box face the ray hit (entry face; exit face if the origin is inside). */
    readonly face: FaceId;
}

/**
 * Slab-method ray vs AABB with face identification.
 *
 * Returns the entry distance and entry face, or `null` on miss. If the ray
 * origin is inside the box, returns `t = 0` with the face the ray will exit
 * through (the only sensible pick for tool interactions).
 */
export function rayAABBFaceHit(ray: Ray, box: AABB): RayFaceHit | null {
    let tmin = -Infinity;
    let tmax = Infinity;
    let entryAxis = -1;
    let exitAxis = -1;

    const mins = [box.minX, box.minY, box.minZ];
    const maxs = [box.maxX, box.maxY, box.maxZ];

    for (let axis = 0; axis < 3; axis++) {
        const o = ray.origin[axis]!;
        const d = ray.dir[axis]!;
        if (Math.abs(d) < 1e-10) {
            if (o < mins[axis]! || o > maxs[axis]!) {
                return null;
            }
            continue;
        }
        let t1 = (mins[axis]! - o) / d;
        let t2 = (maxs[axis]! - o) / d;
        if (t1 > t2) {
            [t1, t2] = [t2, t1];
        }
        if (t1 > tmin) {
            tmin = t1;
            entryAxis = axis;
        }
        if (t2 < tmax) {
            tmax = t2;
            exitAxis = axis;
        }
        if (tmin > tmax) {
            return null;
        }
    }

    if (tmax < 0) {
        return null; // box entirely behind the ray
    }

    if (tmin >= 0 && entryAxis >= 0) {
        // Entering through the min-side face when traveling in +dir, max-side otherwise.
        const side = ray.dir[entryAxis]! > 0 ? 0 : 1;
        return { t: tmin, face: FACE_BY_AXIS[entryAxis]![side]! };
    }

    // Origin inside the box: report the exit face at t = 0.
    if (exitAxis >= 0) {
        const side = ray.dir[exitAxis]! > 0 ? 1 : 0;
        return { t: 0, face: FACE_BY_AXIS[exitAxis]![side]! };
    }
    return null;
}

/** Slab-method ray vs AABB. Returns distance ≥ 0 on hit, or -1 on miss. */
export function rayHitsAABB(ray: Ray, box: AABB): number {
    let tmin = -Infinity;
    let tmax = Infinity;

    const axes: Array<[number, number, number, number]> = [
        [ray.origin[0], ray.dir[0], box.minX, box.maxX],
        [ray.origin[1], ray.dir[1], box.minY, box.maxY],
        [ray.origin[2], ray.dir[2], box.minZ, box.maxZ],
    ];

    for (const [o, d, lo, hi] of axes) {
        if (Math.abs(d) < 1e-10) {
            if (o < lo || o > hi) {
                return -1;
            }
        } else {
            let t1 = (lo - o) / d;
            let t2 = (hi - o) / d;
            if (t1 > t2) {
                [t1, t2] = [t2, t1];
            }
            tmin = Math.max(tmin, t1);
            tmax = Math.min(tmax, t2);
            if (tmin > tmax) {
                return -1;
            }
        }
    }
    return tmin >= 0 ? tmin : tmax >= 0 ? tmax : -1;
}

/** Intersect ray with a horizontal plane at the given Y. Returns [x, z] or null. */
export function rayPlaneY(ray: Ray, planeY: number): [number, number] | null {
    if (Math.abs(ray.dir[1]) < 1e-10) {
        return null;
    }
    const t = (planeY - ray.origin[1]) / ray.dir[1];
    if (t < 0) {
        return null;
    }
    return [ray.origin[0] + t * ray.dir[0], ray.origin[2] + t * ray.dir[2]];
}
