/** Left-handed ↔ right-handed conversion math for the glTF exporter.
 *
 *  Lite is left-handed; glTF is right-handed. Converting passes mirror across the YZ plane
 *  with `C = diag(−1, 1, 1, 1)` (C⁻¹ = C). */

/** Default tolerance for approximate comparisons (`≈` in the architecture doc). */
export const EXPORT_EPSILON = 0.001;

/** Tolerance for omitting values equal to their glTF defaults; small enough to absorb only float noise. */
export const OMIT_EPSILON = 1e-9;

/** True when every component of `a` is within `epsilon` (default {@link EXPORT_EPSILON}) of the
 *  matching component of `b`. */
export function nearlyEqual(a: ArrayLike<number>, b: ArrayLike<number>, epsilon = EXPORT_EPSILON): boolean {
    for (let i = 0; i < b.length; i++) {
        if (!(Math.abs(a[i]! - b[i]!) <= epsilon)) {
            return false;
        }
    }
    return true;
}

export function convertTranslation(x: number, y: number, z: number): [number, number, number] {
    return [-x, y, z];
}

/** The quaternion change of basis `quat(C · mat(q) · C)`, which is the linear map
 *  `L(x, y, z, w) = (x, −y, −z, w)`. Used without sign canonicalization for animation keys
 *  and CUBICSPLINE tangents, where a per-key sign flip would break hemisphere continuity. */
export function mirrorQuat(x: number, y: number, z: number, w: number): [number, number, number, number] {
    return [x, -y, -z, w];
}

/** Convert a static rotation (node TRS, instance rotation, light and camera nodes): apply
 *  {@link mirrorQuat}, canonicalize the sign with the Babylon.js pattern, then normalize.
 *
 *  The pivot is the larger of |x| and |y| when `x² + y² > 0.5`, otherwise the larger of |z| and
 *  |w|; ties go to the later component (y over x, w over z), matching Babylon.js's strict `>`
 *  comparisons. The whole quaternion is negated when the pivot is negative. */
export function convertRotation(x: number, y: number, z: number, w: number): [number, number, number, number] {
    return canonicalizeQuat(x, -y, -z, w);
}

/** Sign-canonicalize and normalize a quaternion with the Babylon.js pivot rule (see {@link convertRotation}). */
export function canonicalizeQuat(x: number, y: number, z: number, w: number): [number, number, number, number] {
    let pivot: number;
    if (x * x + y * y > 0.5) {
        pivot = Math.abs(x) > Math.abs(y) ? x : y;
    } else {
        pivot = Math.abs(z) > Math.abs(w) ? z : w;
    }
    const len = Math.hypot(x, y, z, w);
    const s = (pivot < 0 ? -1 : 1) / (len > 0 ? len : 1);
    return [x * s, y * s, z * s, w * s];
}

/** Normalize a quaternion tuple; a zero quaternion becomes identity. */
export function normalizeQuat(x: number, y: number, z: number, w: number): [number, number, number, number] {
    const len = Math.hypot(x, y, z, w);
    if (!(len > 0)) {
        return [0, 0, 0, 1];
    }
    return [x / len, y / len, z / len, w / len];
}

/** Column-major `C · M · C`: negates the entries where exactly one of row and column is 0. */
export function convertMatrix(m: ArrayLike<number>): number[] {
    const out = new Array<number>(16);
    for (let i = 0; i < 16; i++) {
        const row = i & 3;
        const col = i >> 2;
        out[i] = (row === 0) !== (col === 0) ? -m[i]! : m[i]!;
    }
    return out;
}

/** `q ⊗ (0, 1, 0, 0)`: a 180° yaw applied in the quaternion's local frame. Linear, so it also
 *  applies to animation keys and tangents. Lite cameras look along local +Z; glTF cameras look along −Z. */
export function rotate180Y(x: number, y: number, z: number, w: number): [number, number, number, number] {
    return [-z, w, x, -y];
}

/** Hamilton product `a ⊗ b` of two xyzw quaternions. */
export function multiplyQuat(a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number, number] {
    const ax = a[0]!,
        ay = a[1]!,
        az = a[2]!,
        aw = a[3]!;
    const bx = b[0]!,
        by = b[1]!,
        bz = b[2]!,
        bw = b[3]!;
    return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** The unit quaternion rotating `(0, 0, −1)` onto the normalized direction `d` (Lite's local frame).
 *  The antiparallel case `d ≈ (0, 0, 1)` resolves to a 180° yaw `(0, 1, 0, 0)`. */
export function rotationToDirection(dx: number, dy: number, dz: number): [number, number, number, number] {
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 0)) {
        return [0, 0, 0, 1];
    }
    const x = dx / len;
    const y = dy / len;
    const z = dz / len;
    if (1 - z < 1e-6) {
        return [0, 1, 0, 0];
    }
    return normalizeQuat(y, -x, 0, 1 - z);
}

/** Whether a primitive's triangle winding must be reversed on export.
 *
 *  glTF front faces wind counter-clockwise relative to their normals. Native Lite geometry
 *  (`_authoredSign` +1 or unset) winds against its normals, glTF-loaded geometry (−1) with them,
 *  and negating X flips winding relative to the normals. So: reverse exactly when
 *  `(authoredSign ?? 1) === (convert ? −1 : +1)`. */
export function needsWindingFlip(authoredSign: number | undefined, convert: boolean): boolean {
    return (authoredSign ?? 1) < 0 === convert;
}

/** Whether a quaternion is the identity rotation (either sign) within `epsilon`. */
export function isIdentityRotation(q: ArrayLike<number>, epsilon = OMIT_EPSILON): boolean {
    return nearlyEqual(q, [0, 0, 0, 1], epsilon) || nearlyEqual(q, [0, 0, 0, -1], epsilon);
}
