/**
 * Babylon.js-compatible `Quaternion`.
 *
 * Mutable, backed by `x`/`y`/`z`/`w` fields. Structurally compatible with the
 * Babylon Lite `{ x, y, z, w }` quaternion shape used on transform nodes.
 */

import { Vector3 } from "./vector.js";

export class Quaternion {
    public constructor(
        public x: number = 0,
        public y: number = 0,
        public z: number = 0,
        public w: number = 1
    ) {}

    public set(x: number, y: number, z: number, w: number): this {
        this.x = x;
        this.y = y;
        this.z = z;
        this.w = w;
        return this;
    }

    public copyFrom(source: Quaternion): this {
        this.x = source.x;
        this.y = source.y;
        this.z = source.z;
        this.w = source.w;
        return this;
    }

    public multiply(other: Quaternion): Quaternion {
        return new Quaternion(
            other.w * this.x + other.x * this.w + other.y * this.z - other.z * this.y,
            other.w * this.y - other.x * this.z + other.y * this.w + other.z * this.x,
            other.w * this.z + other.x * this.y - other.y * this.x + other.z * this.w,
            other.w * this.w - other.x * this.x - other.y * this.y - other.z * this.z
        );
    }

    public length(): number {
        return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
    }

    public normalize(): this {
        const len = this.length();
        if (len !== 0) {
            const inv = 1 / len;
            this.x *= inv;
            this.y *= inv;
            this.z *= inv;
            this.w *= inv;
        }
        return this;
    }

    public conjugate(): Quaternion {
        return new Quaternion(-this.x, -this.y, -this.z, this.w);
    }

    public clone(): Quaternion {
        return new Quaternion(this.x, this.y, this.z, this.w);
    }

    public equals(other: Quaternion): boolean {
        return this.x === other.x && this.y === other.y && this.z === other.z && this.w === other.w;
    }

    public asArray(): [number, number, number, number] {
        return [this.x, this.y, this.z, this.w];
    }

    public toEulerAngles(): Vector3 {
        const result = new Vector3();
        const qz = this.z;
        const qx = this.x;
        const qy = this.y;
        const qw = this.w;

        const sqw = qw * qw;
        const sqz = qz * qz;
        const sqx = qx * qx;
        const sqy = qy * qy;

        const zAxisY = qy * qz - qx * qw;
        const limit = 0.4999999;

        if (zAxisY < -limit) {
            result.y = 2 * Math.atan2(qy, qw);
            result.x = Math.PI / 2;
            result.z = 0;
        } else if (zAxisY > limit) {
            result.y = 2 * Math.atan2(qy, qw);
            result.x = -Math.PI / 2;
            result.z = 0;
        } else {
            result.z = Math.atan2(2 * (qx * qy + qz * qw), -sqz - sqx + sqy + sqw);
            result.x = Math.asin(-2 * (qz * qy - qx * qw));
            result.y = Math.atan2(2 * (qz * qx + qy * qw), sqz - sqx - sqy + sqw);
        }

        return result;
    }

    public static Identity(): Quaternion {
        return new Quaternion(0, 0, 0, 1);
    }

    public static FromEulerAngles(x: number, y: number, z: number): Quaternion {
        return Quaternion.RotationYawPitchRoll(y, x, z);
    }

    public static RotationYawPitchRoll(yaw: number, pitch: number, roll: number): Quaternion {
        const halfRoll = roll * 0.5;
        const halfPitch = pitch * 0.5;
        const halfYaw = yaw * 0.5;

        const sinRoll = Math.sin(halfRoll);
        const cosRoll = Math.cos(halfRoll);
        const sinPitch = Math.sin(halfPitch);
        const cosPitch = Math.cos(halfPitch);
        const sinYaw = Math.sin(halfYaw);
        const cosYaw = Math.cos(halfYaw);

        return new Quaternion(
            cosYaw * sinPitch * cosRoll + sinYaw * cosPitch * sinRoll,
            sinYaw * cosPitch * cosRoll - cosYaw * sinPitch * sinRoll,
            cosYaw * cosPitch * sinRoll - sinYaw * sinPitch * cosRoll,
            cosYaw * cosPitch * cosRoll + sinYaw * sinPitch * sinRoll
        );
    }

    public static RotationAxis(axis: Vector3, angle: number): Quaternion {
        const sin = Math.sin(angle / 2);
        const len = axis.length() || 1;
        return new Quaternion((axis.x / len) * sin, (axis.y / len) * sin, (axis.z / len) * sin, Math.cos(angle / 2));
    }

    public static Slerp(left: Quaternion, right: Quaternion, amount: number): Quaternion {
        let num2: number;
        let num3: number;
        const num = amount;
        let dot = left.x * right.x + left.y * right.y + left.z * right.z + left.w * right.w;
        let flip = false;

        if (dot < 0) {
            flip = true;
            dot = -dot;
        }

        if (dot > 0.999999) {
            num3 = 1 - num;
            num2 = flip ? -num : num;
        } else {
            const angle = Math.acos(dot);
            const invSin = 1 / Math.sin(angle);
            num3 = Math.sin((1 - num) * angle) * invSin;
            num2 = flip ? -Math.sin(num * angle) * invSin : Math.sin(num * angle) * invSin;
        }

        return new Quaternion(num3 * left.x + num2 * right.x, num3 * left.y + num2 * right.y, num3 * left.z + num2 * right.z, num3 * left.w + num2 * right.w);
    }
}
