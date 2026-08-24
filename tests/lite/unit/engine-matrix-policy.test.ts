import { describe, expect, it, afterEach } from "vitest";

import { allocateMat4, _setHpmAllocator, _resetMatrixAllocatorForTests } from "../../../packages/babylon-lite/src/math/_matrix-allocator";
import { allocateF64Mat4 } from "../../../packages/babylon-lite/src/math/_mat4-storage-f64";
import { mat4Compose } from "../../../packages/babylon-lite/src/math/mat4-compose";
import { mat4Identity } from "../../../packages/babylon-lite/src/math/mat4-identity";
import { mat4FromQuat } from "../../../packages/babylon-lite/src/math/mat4-from-quat";
import { mat4Invert } from "../../../packages/babylon-lite/src/math/mat4-invert";
import { mat4Multiply } from "../../../packages/babylon-lite/src/math/mat4-multiply";
import { mat4Scale } from "../../../packages/babylon-lite/src/math/mat4-scale";
import { mat4PerspectiveLH } from "../../../packages/babylon-lite/src/math/mat4-perspective-lh";
import { mat4LookAtLH } from "../../../packages/babylon-lite/src/math/mat4-look-at-lh";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";

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

    // ---------------------------------------------------------------------
    // The factories must ALLOCATE THROUGH the allocator, not around it.
    //
    // The tests above prove the allocator switches to F64. They do not prove
    // anything USES it, and for a long time the mat4 factories did not: each
    // hardcoded `new F32(16)`. `createWorldMatrixState` allocates correctly, so a
    // node WITH A PARENT came out F64 and looked fine — but a ROOT node's
    // `getWorldMatrix()` returns its LOCAL matrix, which comes from
    // `composeTrsLocalMatrix` -> `mat4Compose`/`mat4Identity`. So every
    // root-level object silently kept an F32 world transform under
    // `useHighPrecisionMatrix: true`, which is precisely where large-world
    // precision is needed.
    //
    // It surfaced as visible position jitter at ~4.6 million metres from the
    // origin, reported by a person looking at the screen. Nothing typed or
    // tested caught it.

    it("every mat4 factory allocates through the allocator", () => {
        _setHpmAllocator(allocateF64Mat4);
        const q = { x: 0, y: 0, z: 0, w: 1 };
        const a = mat4Identity();
        const factories: Record<string, unknown> = {
            mat4Identity: a,
            mat4Compose: mat4Compose(1, 2, 3, q.x, q.y, q.z, q.w, 1, 1, 1),
            mat4FromQuat: mat4FromQuat(q.x, q.y, q.z, q.w),
            mat4Invert: mat4Invert(a),
            mat4Multiply: mat4Multiply(a, a),
            mat4Scale: mat4Scale(2, 2, 2),
            mat4PerspectiveLH: mat4PerspectiveLH(1, 1, 0.5, 100),
            mat4LookAtLH: mat4LookAtLH({ x: 0, y: 0, z: -5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }),
        };
        // Named individually so a failure says WHICH factory bypassed it, rather
        // than just that one of them did.
        for (const [name, m] of Object.entries(factories)) {
            expect(m, `${name} must allocate through allocateMat4()`).toBeInstanceOf(Float64Array);
        }
    });

    it("a ROOT node keeps sub-metre precision far from the origin under HPM", () => {
        // The behavioural form of the same guarantee, and the one that survives a
        // reimplementation: it asserts what the precision BUYS rather than which
        // typed array happens to back it.
        //
        // 4.6e6 m is where this was found. Float32 ULP there is ~0.5 m, so a 1 cm
        // move vanishes entirely — six consecutive 1 cm nudges all produced the
        // identical matrix value.
        _setHpmAllocator(allocateF64Mat4);
        const FAR = 4_637_862;
        const node = createTransformNode("farNode", FAR, 0, 0);

        const before = node.worldMatrix[12]!;
        node.position.set(FAR + 0.01, 0, 0);
        const after = node.worldMatrix[12]!;

        expect(after).not.toBe(before);
        expect(after - before).toBeCloseTo(0.01, 6);
    });

    it("and the F32 default is what that test would catch", () => {
        // Guards the guard: without HPM the same nudge IS swallowed, so the test
        // above is measuring something real rather than passing regardless.
        const FAR = 4_637_862;
        const node = createTransformNode("farNodeF32", FAR, 0, 0);
        const before = node.worldMatrix[12];
        node.position.set(FAR + 0.01, 0, 0);
        expect(node.worldMatrix[12]).toBe(before);
    });
});
