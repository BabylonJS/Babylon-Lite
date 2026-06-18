/**
 * Babylon.js-compatible `Matrix` (4x4).
 *
 * Storage and conventions match Babylon.js: a 16-element row-major `Float32Array`
 * with translation in elements 12/13/14, and the row-vector convention
 * (`v' = v · M`). `multiply(other)` applies `this` first, then `other`.
 */

import { Vector3 } from "./vector.js";

export class Matrix {
    public readonly m: Float32Array;

    public constructor() {
        this.m = new Float32Array(16);
    }

    public set(index: number, value: number): this {
        this.m[index] = value;
        return this;
    }

    public copyFrom(source: Matrix): this {
        this.m.set(source.m);
        return this;
    }

    public clone(): Matrix {
        const result = new Matrix();
        result.m.set(this.m);
        return result;
    }

    public asArray(): Float32Array {
        return this.m;
    }

    public toArray(): number[] {
        return Array.from(this.m);
    }

    /** Babylon.js `Matrix.copyToArray` — copy the 16 elements into `array` at `offset`. */
    public copyToArray(array: Float32Array | number[], offset = 0): this {
        for (let i = 0; i < 16; i++) {
            array[offset + i] = this.m[i]!;
        }
        return this;
    }

    public equals(other: Matrix): boolean {
        for (let i = 0; i < 16; i++) {
            if (this.m[i] !== other.m[i]) {
                return false;
            }
        }
        return true;
    }

    public multiply(other: Matrix): Matrix {
        return Matrix.FromValues(...multiplyValues(this.m, other.m));
    }

    public multiplyToRef(other: Matrix, result: Matrix): Matrix {
        const values = multiplyValues(this.m, other.m);
        result.m.set(values);
        return result;
    }

    public transpose(): Matrix {
        const a = this.m;
        return Matrix.FromValues(a[0]!, a[4]!, a[8]!, a[12]!, a[1]!, a[5]!, a[9]!, a[13]!, a[2]!, a[6]!, a[10]!, a[14]!, a[3]!, a[7]!, a[11]!, a[15]!);
    }

    public determinant(): number {
        return determinant(this.m);
    }

    public invert(): Matrix {
        const result = new Matrix();
        this.invertToRef(result);
        return result;
    }

    public invertToRef(result: Matrix): Matrix {
        const inv = invertValues(this.m);
        result.m.set(inv);
        return result;
    }

    public getTranslation(): Vector3 {
        return new Vector3(this.m[12]!, this.m[13]!, this.m[14]!);
    }

    public static FromValues(
        m0: number,
        m1: number,
        m2: number,
        m3: number,
        m4: number,
        m5: number,
        m6: number,
        m7: number,
        m8: number,
        m9: number,
        m10: number,
        m11: number,
        m12: number,
        m13: number,
        m14: number,
        m15: number
    ): Matrix {
        const result = new Matrix();
        result.m.set([m0, m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12, m13, m14, m15]);
        return result;
    }

    public static FromArray(array: ArrayLike<number>, offset = 0): Matrix {
        const result = new Matrix();
        for (let i = 0; i < 16; i++) {
            result.m[i] = array[offset + i] ?? 0;
        }
        return result;
    }

    public static Identity(): Matrix {
        return Matrix.FromValues(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    }

    public static Zero(): Matrix {
        return new Matrix();
    }

    public static Translation(x: number, y: number, z: number): Matrix {
        return Matrix.FromValues(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1);
    }

    public static Scaling(x: number, y: number, z: number): Matrix {
        return Matrix.FromValues(x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1);
    }

    public static RotationX(angle: number): Matrix {
        const s = Math.sin(angle);
        const c = Math.cos(angle);
        return Matrix.FromValues(1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1);
    }

    public static RotationY(angle: number): Matrix {
        const s = Math.sin(angle);
        const c = Math.cos(angle);
        return Matrix.FromValues(c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1);
    }

    public static RotationZ(angle: number): Matrix {
        const s = Math.sin(angle);
        const c = Math.cos(angle);
        return Matrix.FromValues(c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    }

    /** Babylon.js `Matrix.LookAtLH(eye, target, up)` — left-handed view matrix. */
    public static LookAtLH(eye: Vector3, target: Vector3, up: Vector3): Matrix {
        // zaxis = normalize(target - eye)
        let zx = target.x - eye.x,
            zy = target.y - eye.y,
            zz = target.z - eye.z;
        const zl = Math.hypot(zx, zy, zz) || 1;
        zx /= zl;
        zy /= zl;
        zz /= zl;
        // xaxis = normalize(cross(up, zaxis))
        let xx = up.y * zz - up.z * zy,
            xy = up.z * zx - up.x * zz,
            xz = up.x * zy - up.y * zx;
        const xl = Math.hypot(xx, xy, xz) || 1;
        xx /= xl;
        xy /= xl;
        xz /= xl;
        // yaxis = cross(zaxis, xaxis)
        const yx = zy * xz - zz * xy,
            yy = zz * xx - zx * xz,
            yz = zx * xy - zy * xx;
        const ex = -(xx * eye.x + xy * eye.y + xz * eye.z);
        const ey = -(yx * eye.x + yy * eye.y + yz * eye.z);
        const ez = -(zx * eye.x + zy * eye.y + zz * eye.z);
        return Matrix.FromValues(xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, ex, ey, ez, 1);
    }

    /** Babylon.js `Matrix.OrthoOffCenterLH(left, right, bottom, top, znear, zfar, halfZRange?)` — LH ortho projection. */
    public static OrthoOffCenterLH(left: number, right: number, bottom: number, top: number, znear: number, zfar: number, _halfZRange?: boolean): Matrix {
        const a = 2 / (right - left);
        const b = 2 / (top - bottom);
        const c = 1 / (zfar - znear);
        const tx = (left + right) / (left - right);
        const ty = (top + bottom) / (bottom - top);
        const tz = -znear * c;
        return Matrix.FromValues(a, 0, 0, 0, 0, b, 0, 0, 0, 0, c, 0, tx, ty, tz, 1);
    }

    /**
     * Babylon.js `Matrix.Compose(scale, rotation, translation)` — build a TRS matrix
     * from a scale vector, a rotation quaternion, and a translation vector (row-vector
     * convention, translation in elements 12/13/14).
     */
    public static Compose(scale: Vector3, rotation: { x: number; y: number; z: number; w: number }, translation: Vector3): Matrix {
        const { x, y, z, w } = rotation;
        const x2 = x + x,
            y2 = y + y,
            z2 = z + z;
        const xx = x * x2,
            xy = x * y2,
            xz = x * z2,
            yy = y * y2,
            yz = y * z2,
            zz = z * z2,
            wx = w * x2,
            wy = w * y2,
            wz = w * z2;
        const sx = scale.x,
            sy = scale.y,
            sz = scale.z;
        return Matrix.FromValues(
            (1 - (yy + zz)) * sx,
            (xy + wz) * sx,
            (xz - wy) * sx,
            0,
            (xy - wz) * sy,
            (1 - (xx + zz)) * sy,
            (yz + wx) * sy,
            0,
            (xz + wy) * sz,
            (yz - wx) * sz,
            (1 - (xx + yy)) * sz,
            0,
            translation.x,
            translation.y,
            translation.z,
            1
        );
    }

    /** Babylon.js `Matrix.markAsUpdated()` — Lite has no per-matrix dirty flag; no-op for parity. */
    public markAsUpdated(): this {
        return this;
    }
}

type Mat16 = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];

function multiplyValues(a: Float32Array, b: Float32Array): Mat16 {
    const result = new Array<number>(16);
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            result[r * 4 + c] = a[r * 4]! * b[c]! + a[r * 4 + 1]! * b[4 + c]! + a[r * 4 + 2]! * b[8 + c]! + a[r * 4 + 3]! * b[12 + c]!;
        }
    }
    return result as Mat16;
}

function determinant(m: Float32Array): number {
    const m00 = m[0]!,
        m01 = m[1]!,
        m02 = m[2]!,
        m03 = m[3]!;
    const m10 = m[4]!,
        m11 = m[5]!,
        m12 = m[6]!,
        m13 = m[7]!;
    const m20 = m[8]!,
        m21 = m[9]!,
        m22 = m[10]!,
        m23 = m[11]!;
    const m30 = m[12]!,
        m31 = m[13]!,
        m32 = m[14]!,
        m33 = m[15]!;

    const b00 = m00 * m11 - m01 * m10;
    const b01 = m00 * m12 - m02 * m10;
    const b02 = m00 * m13 - m03 * m10;
    const b03 = m01 * m12 - m02 * m11;
    const b04 = m01 * m13 - m03 * m11;
    const b05 = m02 * m13 - m03 * m12;
    const b06 = m20 * m31 - m21 * m30;
    const b07 = m20 * m32 - m22 * m30;
    const b08 = m20 * m33 - m23 * m30;
    const b09 = m21 * m32 - m22 * m31;
    const b10 = m21 * m33 - m23 * m31;
    const b11 = m22 * m33 - m23 * m32;

    return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
}

function invertValues(m: Float32Array): Mat16 {
    const m00 = m[0]!,
        m01 = m[1]!,
        m02 = m[2]!,
        m03 = m[3]!;
    const m10 = m[4]!,
        m11 = m[5]!,
        m12 = m[6]!,
        m13 = m[7]!;
    const m20 = m[8]!,
        m21 = m[9]!,
        m22 = m[10]!,
        m23 = m[11]!;
    const m30 = m[12]!,
        m31 = m[13]!,
        m32 = m[14]!,
        m33 = m[15]!;

    const b00 = m00 * m11 - m01 * m10;
    const b01 = m00 * m12 - m02 * m10;
    const b02 = m00 * m13 - m03 * m10;
    const b03 = m01 * m12 - m02 * m11;
    const b04 = m01 * m13 - m03 * m11;
    const b05 = m02 * m13 - m03 * m12;
    const b06 = m20 * m31 - m21 * m30;
    const b07 = m20 * m32 - m22 * m30;
    const b08 = m20 * m33 - m23 * m30;
    const b09 = m21 * m32 - m22 * m31;
    const b10 = m21 * m33 - m23 * m31;
    const b11 = m22 * m33 - m23 * m32;

    const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (det === 0) {
        return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    }
    const invDet = 1 / det;

    return [
        (m11 * b11 - m12 * b10 + m13 * b09) * invDet,
        (m02 * b10 - m01 * b11 - m03 * b09) * invDet,
        (m31 * b05 - m32 * b04 + m33 * b03) * invDet,
        (m22 * b04 - m21 * b05 - m23 * b03) * invDet,
        (m12 * b08 - m10 * b11 - m13 * b07) * invDet,
        (m00 * b11 - m02 * b08 + m03 * b07) * invDet,
        (m32 * b02 - m30 * b05 - m33 * b01) * invDet,
        (m20 * b05 - m22 * b02 + m23 * b01) * invDet,
        (m10 * b10 - m11 * b08 + m13 * b06) * invDet,
        (m01 * b08 - m00 * b10 - m03 * b06) * invDet,
        (m30 * b04 - m31 * b02 + m33 * b00) * invDet,
        (m21 * b02 - m20 * b04 - m23 * b00) * invDet,
        (m11 * b07 - m10 * b09 - m12 * b06) * invDet,
        (m00 * b09 - m01 * b07 + m02 * b06) * invDet,
        (m31 * b01 - m30 * b03 - m32 * b00) * invDet,
        (m20 * b03 - m21 * b01 + m22 * b00) * invDet,
    ];
}

/**
 * Babylon.js-compatible vector × matrix transforms (static helpers that live on
 * `Vector3` in Babylon.js). Kept here to avoid a circular import between the
 * vector and matrix modules.
 */
export function transformCoordinates(vector: Vector3, transformation: Matrix): Vector3 {
    const m = transformation.m;
    const x = vector.x;
    const y = vector.y;
    const z = vector.z;
    const rx = x * m[0]! + y * m[4]! + z * m[8]! + m[12]!;
    const ry = x * m[1]! + y * m[5]! + z * m[9]! + m[13]!;
    const rz = x * m[2]! + y * m[6]! + z * m[10]! + m[14]!;
    const rw = 1 / (x * m[3]! + y * m[7]! + z * m[11]! + m[15]!);
    return new Vector3(rx * rw, ry * rw, rz * rw);
}

export function transformNormal(vector: Vector3, transformation: Matrix): Vector3 {
    const m = transformation.m;
    const x = vector.x;
    const y = vector.y;
    const z = vector.z;
    return new Vector3(x * m[0]! + y * m[4]! + z * m[8]!, x * m[1]! + y * m[5]! + z * m[9]!, x * m[2]! + y * m[6]! + z * m[10]!);
}
