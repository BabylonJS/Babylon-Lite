import type { Mat4 } from "../math/types.js";
import { mat4Invert } from "../math/mat4-invert.js";

/** A ray defined by origin, direction, and length. */
export interface Ray {
    origin: [number, number, number];
    direction: [number, number, number];
    length: number;
}

/**
 * Create a picking ray from screen coordinates.
 * Uses left-handed coordinates with WebGPU reverse-Z 0-to-1 depth range.
 */
export function createPickingRay(x: number, y: number, vpMatrix: Mat4, width: number, height: number): Ray | null {
    const invVP = mat4Invert(vpMatrix);
    if (!invVP) {
        return null;
    }

    // Convert screen coords to NDC (Y flipped for WebGPU)
    const ndcX = (2 * x) / width - 1;
    const ndcY = 1 - (2 * y) / height;

    // Reverse-Z maps near to 1 and far to 0.
    const near = unprojectPoint(invVP, ndcX, ndcY, 1);
    const far = unprojectPoint(invVP, ndcX, ndcY, 0);

    const dx = far[0] - near[0];
    const dy = far[1] - near[1];
    const dz = far[2] - near[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (len < 1e-10) {
        return null;
    }

    const invLen = 1 / len;
    return {
        origin: near,
        direction: [dx * invLen, dy * invLen, dz * invLen],
        length: len,
    };
}

/** Unproject a clip-space point through an inverse VP matrix. */
function unprojectPoint(invVP: Mat4, ndcX: number, ndcY: number, depth: number): [number, number, number] {
    // Multiply invVP * [ndcX, ndcY, depth, 1.0]
    const x = invVP[0]! * ndcX + invVP[4]! * ndcY + invVP[8]! * depth + invVP[12]!;
    const y = invVP[1]! * ndcX + invVP[5]! * ndcY + invVP[9]! * depth + invVP[13]!;
    const z = invVP[2]! * ndcX + invVP[6]! * ndcY + invVP[10]! * depth + invVP[14]!;
    const w = invVP[3]! * ndcX + invVP[7]! * ndcY + invVP[11]! * depth + invVP[15]!;
    const invW = 1 / w;
    return [x * invW, y * invW, z * invW];
}
