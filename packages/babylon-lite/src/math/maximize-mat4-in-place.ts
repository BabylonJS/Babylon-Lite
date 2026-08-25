/**
 * Replaces every element of `target` with the larger value from `target` and
 * `other`.
 */
export function maximizeMat4InPlace(target: Float32Array, other: ArrayLike<number>): Float32Array {
    for (let index = 0; index < 16; index++) {
        target[index] = Math.max(target[index]!, other[index]!);
    }
    return target;
}
