import type { Mat4, Mat4Storage } from "./types.js";

/** Set the translation components of a 4x4 matrix in place. */
export function setMat4Translation<T extends Mat4 | Float32Array | Float64Array>(matrix: T, x: number, y: number, z: number): T {
    const storage = matrix as Mat4Storage;
    storage[12] = x;
    storage[13] = y;
    storage[14] = z;
    return matrix;
}
