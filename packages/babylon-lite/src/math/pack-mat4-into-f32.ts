import type { Mat4 } from "./types.js";
import type { Mat4Storage } from "./types.js";

const ZERO_OFFSET: readonly [number, number, number] = [0, 0, 0];

/** @internal Pack one Mat4 into a Float32Array upload view at the given float
 *  offset. Source storage may be F32 or F64; this is the only place in the
 *  package where F64→F32 downcast happens for GPU upload. Does not allocate.
 *
 *  When `srcOffsetFloats` is provided, the helper reads 16 floats starting at
 *  `src[srcOffsetFloats]` instead of `src[0]`. This lets thin-instance and
 *  similar packed-slab uploaders walk a `Float32Array | Float64Array` of N×16
 *  values without subarray allocation.
 *
 *  When `offsetXYZ` is provided, the floating-origin offset is subtracted from
 *  the translation column `[12..14]` during pack — used by mesh-world UBO
 *  uploads when the engine has LWR on. The subtraction happens in JavaScript
 *  number precision (F64) BEFORE the implicit F32 store, which is what wins
 *  the precision back: for an F64-backed `Mat4` the result of
 *  `large - large = small` is computed at full F64 precision, then a single
 *  F32 store rounds the small remainder with ample headroom.
 *
 *  Default `offsetXYZ` is a shared `[0, 0, 0]` constant — the three
 *  subtract-zero operations are negligible at runtime, and using one constant
 *  array avoids per-call allocation. View / view-projection / non-mesh-world
 *  uploads omit the parameter and get the original precision-only behaviour.
 *
 *  The 16 element writes are intentionally unrolled to match the style of the
 *  mat4 kernels and avoid an indexable loop in hot paths. Do NOT replace with
 *  `view.set(src, offsetFloats)` — that pattern is the one Task 4.1 audits OUT
 *  outside this single helper. */
export function packMat4IntoF32(
    view: Float32Array,
    mat: Mat4 | Float32Array | Float64Array,
    offsetFloats: number = 0,
    srcOffsetFloats: number = 0,
    offsetXYZ: readonly [number, number, number] = ZERO_OFFSET
): void {
    const src = mat as Mat4 as unknown as Mat4Storage;
    const s = srcOffsetFloats;
    const o = offsetFloats;
    view[o + 0] = src[s + 0]!;
    view[o + 1] = src[s + 1]!;
    view[o + 2] = src[s + 2]!;
    view[o + 3] = src[s + 3]!;
    view[o + 4] = src[s + 4]!;
    view[o + 5] = src[s + 5]!;
    view[o + 6] = src[s + 6]!;
    view[o + 7] = src[s + 7]!;
    view[o + 8] = src[s + 8]!;
    view[o + 9] = src[s + 9]!;
    view[o + 10] = src[s + 10]!;
    view[o + 11] = src[s + 11]!;
    view[o + 12] = src[s + 12]! - offsetXYZ[0];
    view[o + 13] = src[s + 13]! - offsetXYZ[1];
    view[o + 14] = src[s + 14]! - offsetXYZ[2];
    view[o + 15] = src[s + 15]!;
}
