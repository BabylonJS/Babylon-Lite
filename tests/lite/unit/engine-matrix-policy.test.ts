import { describe, expect, it, afterEach } from "vitest";

import { allocateMat4, _setHpmAllocator, _resetMatrixAllocatorForTests } from "../../../packages/babylon-lite/src/math/_matrix-allocator";
import { allocateF64Mat4 } from "../../../packages/babylon-lite/src/math/_mat4-storage-f64";

// The matrix allocator is a process-global lazy singleton (GUIDANCE pillar 4,
// lazy-init form). `createEngine` flips the singleton to F64 when
// `useHighPrecisionMatrix: true`. We exercise the singleton directly here
// because `createEngine` requires a live WebGPU adapter unavailable under
// vitest. Each test resets back to F32 to avoid leaking state.
//
// **Constraint under test:** the allocator is process-global. Pages that mix
// HPM and non-HPM engines on the same page are unsupported (see
// `docs/lite/architecture/36-high-precision-matrix.md`). This test does not exercise the
// constraint — it documents that the second installer wins silently.

describe("matrix allocator (process-global singleton)", () => {
    afterEach(() => _resetMatrixAllocatorForTests());

    it("default (HPM never installed) yields a Float32Array", () => {
        const m = allocateMat4() as unknown as Float32Array;
        expect(m).toBeInstanceOf(Float32Array);
        expect(m.length).toBe(16);
    });

    it("after _setHpmAllocator(allocateF64Mat4), allocateMat4 returns Float64Array", () => {
        _setHpmAllocator(allocateF64Mat4);
        const m = allocateMat4() as unknown as Float64Array;
        expect(m).toBeInstanceOf(Float64Array);
        expect(m.length).toBe(16);
    });

    it("each call returns a fresh, independent typed array", () => {
        const a = allocateMat4() as unknown as Float32Array;
        const b = allocateMat4() as unknown as Float32Array;
        expect(a).not.toBe(b);
        a[0] = 42;
        expect(b[0]).toBe(0);
    });

    it("_resetMatrixAllocatorForTests reverts to F32 default", () => {
        _setHpmAllocator(allocateF64Mat4);
        expect(allocateMat4()).toBeInstanceOf(Float64Array);
        _resetMatrixAllocatorForTests();
        expect(allocateMat4()).toBeInstanceOf(Float32Array);
    });
});
