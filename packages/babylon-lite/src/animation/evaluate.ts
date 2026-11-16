// Keyframe interpolation engine — LINEAR, STEP, CUBICSPLINE.
// Pure functions, zero allocation in the hot path.

import { F32 } from "../engine/typed-arrays.js";
import type { AnimationEasing } from "./easing.js";
import type { AnimationSampler } from "./types.js";
import { INTERP_STEP, INTERP_CUBICSPLINE } from "./types.js";

/** Binary search: find index i such that `input[i] <= t < input[i+1]`. */
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
const _quat = new F32([0, 0, 0, 1]);

/** Normalise 4 consecutive components (quaternion) in-place. No-op on zero length. */
function normalizeQuat4(buf: Float32Array, o: number): void {
    const x = buf[o]!;
    const y = buf[o + 1]!;
    const z = buf[o + 2]!;
    const w = buf[o + 3]!;
    const lenSq = x * x + y * y + z * z + w * w;
    if (lenSq > 0) {
        const inv = 1 / Math.sqrt(lenSq);
        buf[o] = x * inv;
        buf[o + 1] = y * inv;
        buf[o + 2] = z * inv;
        buf[o + 3] = w * inv;
    }
}

/** Spherical linear interpolation between two quaternions. Writes to out[].
 *  Lives here (not in math/mat4.ts) so non-animated scenes don't pay for it. */
function quatSlerp(out: Float32Array, ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number, t: number): void {
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
        normalizeQuat4(out, 0);
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

/** Babylon.js-compatible quaternion interpolation for caller-authored property animation. */
function propertyQuatSlerp(out: Float32Array, ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number, t: number): void {
    let dot = ax * bx + ay * by + az * bz + aw * bw;
    let endWeight: number;
    let startWeight: number;
    const negateEnd = dot < 0;
    if (negateEnd) {
        dot = -dot;
    }
    if (dot > 0.999999) {
        startWeight = 1 - t;
        endWeight = negateEnd ? -t : t;
    } else {
        const angle = Math.acos(dot);
        const inverseSine = 1 / Math.sin(angle);
        startWeight = Math.sin((1 - t) * angle) * inverseSine;
        endWeight = (negateEnd ? -1 : 1) * Math.sin(t * angle) * inverseSine;
    }
    out[0] = startWeight * ax + endWeight * bx;
    out[1] = startWeight * ay + endWeight * by;
    out[2] = startWeight * az + endWeight * bz;
    out[3] = startWeight * aw + endWeight * bw;
}

function copySample(output: Float32Array, srcOffset: number, stride: number, dst: Float32Array, dstOffset: number): void {
    for (let c = 0; c < stride; c++) {
        dst[dstOffset + c] = output[srcOffset + c]!;
    }
}

function interpolateLinearSample(output: Float32Array, keyIndex: number, stride: number, isQuat: boolean, gradient: number, dst: Float32Array, dstOffset: number): void {
    const s0 = keyIndex * stride;
    const s1 = (keyIndex + 1) * stride;
    if (isQuat) {
        propertyQuatSlerp(_quat, output[s0]!, output[s0 + 1]!, output[s0 + 2]!, output[s0 + 3]!, output[s1]!, output[s1 + 1]!, output[s1 + 2]!, output[s1 + 3]!, gradient);
        dst[dstOffset] = _quat[0]!;
        dst[dstOffset + 1] = _quat[1]!;
        dst[dstOffset + 2] = _quat[2]!;
        dst[dstOffset + 3] = _quat[3]!;
        return;
    }
    for (let c = 0; c < stride; c++) {
        dst[dstOffset + c] = output[s0 + c]! + gradient * (output[s1 + c]! - output[s0 + c]!);
    }
}

/**
 * Evaluate a sampler at time `t` and write the result into `dst` at `dstOffset`.
 * @param stride - Number of components per value (3 for vec3, 4 for quat).
 * @param isQuat - True for rotation channels (uses slerp instead of lerp).
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
        const srcOff = (t >= t1 ? idx + 1 : idx) * stride;
        for (let c = 0; c < stride; c++) {
            dst[dstOffset + c] = output[srcOff + c]!;
        }
        return;
    }

    const dt = t1 - t0;
    const f = t >= t1 ? 1 : dt > 0 ? (t - t0) / dt : 0; // fractional time between keyframes

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
            normalizeQuat4(dst, dstOffset);
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

/**
 * Evaluate a caller-authored property sampler with an optional transform of the
 * selected segment's normalized progress. Kept separate from {@link evaluateSampler}
 * so imported glTF samplers retain their unchanged LINEAR/STEP/CUBICSPLINE path.
 */
export function evaluatePropertySampler(
    sampler: AnimationSampler,
    t: number,
    stride: number,
    isQuat: boolean,
    easing: AnimationEasing | undefined,
    dst: Float32Array,
    dstOffset: number
): void {
    const { input, output, interpolation } = sampler;
    // Property key times are stored as Float32. Canonicalize caller-authored
    // double-precision times to the same domain so exact frame/key boundaries
    // select the authored key rather than the preceding STEP segment.
    const sampleTime = Math.fround(t);
    const keyCount = input.length;

    if (keyCount === 0) {
        return;
    }
    if (keyCount === 1 || sampleTime <= input[0]!) {
        copySample(output, 0, stride, dst, dstOffset);
        return;
    }
    if (sampleTime >= input[keyCount - 1]!) {
        copySample(output, (keyCount - 1) * stride, stride, dst, dstOffset);
        return;
    }

    const idx = findKeyframe(input, sampleTime);
    if (interpolation === INTERP_STEP) {
        copySample(output, idx * stride, stride, dst, dstOffset);
        return;
    }

    const t0 = input[idx]!;
    const t1 = input[idx + 1]!;
    const dt = t1 - t0;
    const linearGradient = dt > 0 ? (sampleTime - t0) / dt : 0;
    const gradient = easing ? easing(linearGradient) : linearGradient;

    interpolateLinearSample(output, idx, stride, isQuat, gradient, dst, dstOffset);
}
