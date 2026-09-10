/** Set the translation components of a 4x4 matrix in place. */
export function setMat4Translation<T extends Float32Array | Float64Array>(matrix: T, x: number, y: number, z: number): T {
    matrix[12] = x;
    matrix[13] = y;
    matrix[14] = z;
    return matrix;
}
