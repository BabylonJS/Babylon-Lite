// Keyframe interpolation engine — LINEAR, STEP, CUBICSPLINE.
// Pure functions, zero allocation in the hot path.

import type { AnimationSampler } from "./types.js";
import { INTERP_STEP, INTERP_CUBICSPLINE } from "./types.js";

/** Binary search: find index i such that input[i] <= t < input[i+1]. */
function findKeyframe(input: Float32Array, t: number): number {
    let lo = 0;
    let hi = input.length - 1;
    if (t <= input[0]!) {
        return 0;
    }
    if (t >= input[hi]!) {
        return hi > 0 ? hi - 1 : 0;
    }
    while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (input[mid]! <= t) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

// Reusable scratch for quaternion slerp (avoids per-call allocation)
const _quat = [0, 0, 0, 1];

/** Spherical linear interpolation between two quaternions. Writes to out[].
 *  Lives here (not in math/mat4.ts) so non-animated scenes don't pay for it. */
function quatSlerp(out: number[], ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number, t: number): void {
    let dot = ax * bx + ay * by + az * bz + aw * bw;
    if (dot < 0) {
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
        dot = -dot;
    }
    if (dot > 0.9995) {
        // Near-parallel: linear interpolation + normalize
        out[0] = ax + t * (bx - ax);
        out[1] = ay + t * (by - ay);
        out[2] = az + t * (bz - az);
        out[3] = aw + t * (bw - aw);
        const len = 1 / Math.sqrt(out[0]! * out[0]! + out[1]! * out[1]! + out[2]! * out[2]! + out[3]! * out[3]!);
        out[0]! *= len;
        out[1]! *= len;
        out[2]! *= len;
        out[3]! *= len;
        return;
    }
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / sinTheta;
    const wb = Math.sin(t * theta) / sinTheta;
    out[0] = wa * ax + wb * bx;
    out[1] = wa * ay + wb * by;
    out[2] = wa * az + wb * bz;
    out[3] = wa * aw + wb * bw;
}

/**
 * Evaluate a sampler at time `t` and write the result into `dst` at `dstOffset`.
 * @param stride  Number of components per value (3 for vec3, 4 for quat).
 * @param isQuat  True for rotation channels (uses slerp instead of lerp).
 */
export function evaluateSampler(sampler: AnimationSampler, t: number, stride: number, isQuat: boolean, dst: Float32Array, dstOffset: number): void {
    const { input, output, interpolation } = sampler;
    const keyCount = input.length;

    if (keyCount === 0) {
        return;
    }
    if (keyCount === 1 || t <= input[0]!) {
        // Clamp to first keyframe
        const srcOff = interpolation === INTERP_CUBICSPLINE ? stride : 0; // skip in-tangent
        for (let c = 0; c < stride; c++) {
            dst[dstOffset + c] = output[srcOff + c]!;
        }
        return;
    }

    const idx = findKeyframe(input, t);
    const t0 = input[idx]!;
    const t1 = input[idx + 1]!;

    if (interpolation === INTERP_STEP) {
        const srcOff = idx * stride;
        for (let c = 0; c < stride; c++) {
            dst[dstOffset + c] = output[srcOff + c]!;
        }
        return;
    }

    const dt = t1 - t0;
    const f = dt > 0 ? (t - t0) / dt : 0; // fractional time between keyframes

    if (interpolation === INTERP_CUBICSPLINE) {
        // Hermite spline: p(t) = (2t³-3t²+1)p0 + (t³-2t²+t)m0 + (-2t³+3t²)p1 + (t³-t²)m1
        const f2 = f * f;
        const f3 = f2 * f;
        const h00 = 2 * f3 - 3 * f2 + 1;
        const h10 = f3 - 2 * f2 + f;
        const h01 = -2 * f3 + 3 * f2;
        const h11 = f3 - f2;

        const k0 = idx * stride * 3; // [inTangent0, value0, outTangent0]
        const k1 = (idx + 1) * stride * 3;
        for (let c = 0; c < stride; c++) {
            const p0 = output[k0 + stride + c]!; // value at idx
            const m0 = output[k0 + 2 * stride + c]! * dt; // outTangent at idx * deltaTime
            const p1 = output[k1 + stride + c]!; // value at idx+1
            const m1 = output[k1 + c]! * dt; // inTangent at idx+1 * deltaTime
            dst[dstOffset + c] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
        }

        // Normalize quaternion result for cubicspline rotation
        if (isQuat) {
            const o = dstOffset;
            const len = Math.sqrt(dst[o]! * dst[o]! + dst[o + 1]! * dst[o + 1]! + dst[o + 2]! * dst[o + 2]! + dst[o + 3]! * dst[o + 3]!);
            if (len > 0) {
                const inv = 1 / len;
                dst[o] = dst[o]! * inv;
                dst[o + 1] = dst[o + 1]! * inv;
                dst[o + 2] = dst[o + 2]! * inv;
                dst[o + 3] = dst[o + 3]! * inv;
            }
        }
        return;
    }

    // LINEAR interpolation
    const s0 = idx * stride;
    const s1 = (idx + 1) * stride;

    if (isQuat) {
        quatSlerp(_quat, output[s0]!, output[s0 + 1]!, output[s0 + 2]!, output[s0 + 3]!, output[s1]!, output[s1 + 1]!, output[s1 + 2]!, output[s1 + 3]!, f);
        dst[dstOffset] = _quat[0]!;
        dst[dstOffset + 1] = _quat[1]!;
        dst[dstOffset + 2] = _quat[2]!;
        dst[dstOffset + 3] = _quat[3]!;
    } else {
        for (let c = 0; c < stride; c++) {
            dst[dstOffset + c] = output[s0 + c]! + f * (output[s1 + c]! - output[s0 + c]!);
        }
    }
}
