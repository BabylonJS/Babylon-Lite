import type { Mat4 } from "./types.js";
import type { Mat4Storage } from "./types.js";

/** @internal Pack one Mat4 into a Float32Array upload view at the given float
 *  offset. Source storage may be F32 or F64; this is the F64→F32 downcast
 *  point for the precision-only path (every uploader except mesh-world UBOs
 *  in LWR-on engines). Does not allocate.
 *
 *  Fast path: when `srcOffsetFloats === 0` **and** `mat.length === 16` (the
 *  single-matrix case: view, projection, mesh-world UBO uploads), uses the
 *  native `TypedArray.prototype.set` which correctly downcasts F64→F32 in a
 *  single intrinsic. Smaller and faster than the unrolled walk.
 *
 *  Slow path: when `srcOffsetFloats > 0` or `mat` is a multi-matrix slab
 *  (thin-instance walks, `mat.length === N * 16`), the 16-element walk reads
 *  16 floats starting at `src[srcOffsetFloats]` without subarray allocation.
 *
 *  LWR-on engines route mesh-world UBO uploads through
 *  `large-world/pack-mat4-with-offset.ts:packMat4IntoF32WithOffset` (5-arg
 *  variant that subtracts the floating-origin offset before the F32 store).
 *  That module is dynamic-imported only when `useFloatingOrigin: true`, so
 *  non-LWR bundles never reference the offset-subtracting variant. */
export function packMat4IntoF32(view: Float32Array, mat: Mat4 | Float32Array | Float64Array, offsetFloats: number = 0, srcOffsetFloats: number = 0): void {
    const src = mat as Mat4 as unknown as Mat4Storage;
    if (srcOffsetFloats === 0 && src.length === 16) {
        view.set(src, offsetFloats);
        return;
    }
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
    view[o + 12] = src[s + 12]!;
    view[o + 13] = src[s + 13]!;
    view[o + 14] = src[s + 14]!;
    view[o + 15] = src[s + 15]!;
}
