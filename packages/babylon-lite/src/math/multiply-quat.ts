import { type Quat } from "./types";

/** Multiply two Quat: out = a * b */
export function multiplyQuat(q1: Quat, q2: Quat): Quat {
    return {
        x: q1.w * q2.x + q1.x * q2.w + q1.y * q2.z - q1.z * q2.y,
        y: q1.w * q2.y + q1.y * q2.w + q1.z * q2.x - q1.x * q2.z,
        z: q1.w * q2.z + q1.z * q2.w + q1.x * q2.y - q1.y * q2.x,
        w: q1.w * q2.w - q1.x * q2.x - q1.y * q2.y - q1.z * q2.z,
    };
}
