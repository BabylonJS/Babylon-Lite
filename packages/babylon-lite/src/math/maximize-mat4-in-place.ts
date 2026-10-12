import type { Mat4, Mat4Storage } from "./types.js";

/**
 * Replaces every element of `target` with the larger value from `target` and
 * `other`.
 */
export function maximizeMat4InPlace<T extends Mat4 | Float32Array | Float64Array>(target: T, other: ArrayLike<number>): T {
    const storage = target as Mat4Storage;
    for (let index = 0; index < 16; index++) {
        storage[index] = Math.max(storage[index]!, other[index]!);
    }
    return target;
}
