import type { Vec3Tuple } from "./types.js";

/**
 * Normalizes the vector `(x, y, z)` to unit length.
 * @param x - X component.
 * @param y - Y component.
 * @param z - Z component.
 * @param epsilon - Length threshold below which the vector is treated as degenerate.
 * @returns The unit-length vector, or `[0, 1, 0]` if the input length is at or below `epsilon`.
 */
export function normalizeVec3(x: number, y: number, z: number, epsilon = 1e-10): Vec3Tuple {
    const len = Math.hypot(x, y, z);
    if (len <= epsilon) {
        return [0, 1, 0];
    }
    return [x / len, y / len, z / len];
}
