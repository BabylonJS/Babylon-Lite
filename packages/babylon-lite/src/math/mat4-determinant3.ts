/** Determinant of the upper-left 3×3 of a column-major 4×4 matrix.
 *  Standalone function for tree-shaking — only bundled when used. */

/**
 * Determinant of a column-major matrix's upper-left 3×3 block, as the scalar triple product of its
 * basis columns. A negative result means the transform mirrors the geometry it is applied to, which
 * reverses triangle winding and turns a rotation into an improper one.
 *
 * Accepts any indexable of at least 11 numbers so it can be used both on a {@link Mat4} and on a
 * raw glTF `node.matrix` array straight out of the JSON.
 * @param m - Column-major matrix (elements 0-2 = basis X, 4-6 = basis Y, 8-10 = basis Z).
 * @returns The 3×3 determinant; negative when the basis is mirrored.
 */
export function mat4Determinant3(m: ArrayLike<number>): number {
    return m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) + m[1]! * (m[6]! * m[8]! - m[4]! * m[10]!) + m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!);
}
