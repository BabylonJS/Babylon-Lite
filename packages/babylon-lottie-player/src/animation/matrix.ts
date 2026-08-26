// 2D affine matrices stored as [a, b, c, d, e, f] mapping
//   (x, y) -> (a*x + c*y + e, b*x + d*y + f)
// This matches the 2x3 column convention used by canvas/Lottie.

export type Mat2D = [number, number, number, number, number, number];

/** Returns m * n (apply `n` first, then `m`). */
export function multiply(m: Mat2D, n: Mat2D): Mat2D {
    return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ];
}

/** Transform a point through `m`, writing into `out`. */
export function apply(m: Mat2D, x: number, y: number, out: [number, number]): void {
    out[0] = m[0] * x + m[2] * y + m[4];
    out[1] = m[1] * x + m[3] * y + m[5];
}

/**
 * Build a Lottie transform matrix: T(position) * R(rotation) * S(scale) * T(-anchor).
 * `scale` is in percent (100 = identity); `rotationDeg` in degrees.
 */
export function lottieTransform(anchor: number[], position: number[], scale: number[], rotationDeg: number): Mat2D {
    const rad = (rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const sx = scale[0] / 100;
    const sy = scale[1] / 100;
    // Rotation * Scale (upper 2x2).
    const a = cos * sx;
    const b = sin * sx;
    const c = -sin * sy;
    const d = cos * sy;
    // Translate so the anchor maps to position.
    const e = position[0] - (a * anchor[0] + c * anchor[1]);
    const f = position[1] - (b * anchor[0] + d * anchor[1]);
    return [a, b, c, d, e, f];
}
