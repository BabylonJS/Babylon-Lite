/**
 * Floating-origin upload integration test (LWR M1).
 *
 * Validates that the eye-relative trick is actually applied at the upload
 * boundary by exercising both halves end-to-end without a real WebGPU
 * device:
 *
 *   1. View-matrix construction: a camera at world (1e6, 0, 0) whose
 *      `_floatingOriginOffset` is wired to a matching offset array must
 *      produce a view matrix whose translation column is exactly zero
 *      (mathematically: -R_inv * (cameraPos - offset) = 0). This
 *      proves getViewMatrix consumes camera._floatingOriginOffset.
 *
 *   2. Mesh-world UBO upload: a mesh whose worldMatrix translation is
 *      (1e6 + delta, 0, 0) packed via packMat4IntoF32WithOffset with the
 *      same offset must land delta into the F32 view (not 1e6+delta).
 *      This proves the packer runs the F64 subtraction before the F32
 *      store. Comparing against the precision-only packer shows the
 *      precision rescue.
 *
 *   3. vEyePosition style write: camera.worldMatrix[12..14] minus the
 *      offset yields zero (eye-relative).
 */
import { describe, expect, it } from "vitest";

import type { EngineContextInternal } from "../../packages/babylon-lite/src/engine/engine";
import type { MatrixAllocator } from "../../packages/babylon-lite/src/math/_matrix-allocator";
import { createF64MatrixAllocator } from "../../packages/babylon-lite/src/math/_mat4-storage-f64";
import { createArcRotateCamera } from "../../packages/babylon-lite/src/camera/arc-rotate";
import { getViewMatrix } from "../../packages/babylon-lite/src/camera/camera";
import { packMat4IntoF32 } from "../../packages/babylon-lite/src/math/pack-mat4-into-f32";
import { packMat4IntoF32WithOffset } from "../../packages/babylon-lite/src/math/pack-mat4-into-f32-with-offset";

function fakeEngine(allocator: MatrixAllocator): EngineContextInternal {
    return { _matrixPolicy: allocator } as unknown as EngineContextInternal;
}

describe("LWR M1 floating-origin upload integration", () => {
    const FAR = 1_000_000;
    const allocator = createF64MatrixAllocator();
    const engine = fakeEngine(allocator);
    const offset: [number, number, number] = [FAR, 0, FAR];

    it("getViewMatrix subtracts the offset from cameraPos — translation column lands at zero", () => {
        // Arc-rotate camera looking at the far point with the camera positioned
        // exactly at the floating-origin offset (cameraPos == offset).
        const cam = createArcRotateCamera(engine, 0, Math.PI / 2, 0.0001, { x: FAR, y: 0, z: FAR });
        cam._floatingOriginOffset = offset;
        // Camera world position equals offset (within float precision).
        const w = cam.worldMatrix;
        expect(w[12]).toBeCloseTo(FAR, 0);
        expect(w[14]).toBeCloseTo(FAR, 0);

        const v = getViewMatrix(cam);
        // Translation column must be mathematically zero (small floating noise
        // from radius=0.0001 dot products is fine — well under 1m).
        expect(Math.abs(v[12]!)).toBeLessThan(1e-3);
        expect(Math.abs(v[13]!)).toBeLessThan(1e-3);
        expect(Math.abs(v[14]!)).toBeLessThan(1e-3);
    });

    it("getViewMatrix without offset (null _floatingOriginOffset) produces large-magnitude translation — control case", () => {
        const cam = createArcRotateCamera(engine, 0, Math.PI / 2, 0.0001, { x: FAR, y: 0, z: FAR });
        // No offset wired (cam._floatingOriginOffset stays undefined).
        const v = getViewMatrix(cam);
        // Without the offset the view translation is -R_inv * cameraPos, whose
        // magnitude is order 1e6. Confirms the offset path is what makes it small.
        const mag = Math.hypot(v[12]!, v[13]!, v[14]!);
        expect(mag).toBeGreaterThan(1e5);
    });

    it("packMat4IntoF32WithOffset on a mesh at world (1e6 + delta) lands delta into the F32 view", () => {
        // At 1e6 the F32 ULP is ~0.0625 (2^(19-23)). Pick a delta well below
        // half-ULP so the precision-only packer demonstrably loses it; the
        // offset-aware packer recovers it via the F64 subtraction.
        const delta = 1.5e-3;
        const meshWorld = allocator.allocate();
        const w = meshWorld as unknown as Float64Array;
        w[0] = 1;
        w[5] = 1;
        w[10] = 1;
        w[12] = FAR + delta;
        w[13] = 0;
        w[14] = 0;
        w[15] = 1;

        const view = new Float32Array(16);
        packMat4IntoF32WithOffset(view, meshWorld, [FAR, 0, 0]);
        // F64 large-minus-large yields `delta` exactly in F64, then F32 stores
        // a value within F32 precision of delta (delta itself is 1.5e-3 in F64
        // which rounds to Math.fround(delta) in F32 — no further loss).
        expect(view[12]).toBe(Math.fround(delta));

        // Contrast: the precision-only packer downcasts `FAR + delta` directly,
        // which is ULP-quantized at this magnitude — delta is lost entirely.
        const refView = new Float32Array(16);
        packMat4IntoF32(refView, meshWorld);
        expect(refView[12]).toBe(Math.fround(FAR + delta));
        // Recovered remainder after subtraction is NOT delta (it is the zero-
        // ULP-bin centre, which differs from the original delta).
        expect(refView[12] - FAR).not.toBe(Math.fround(delta));
    });

    it("vEyePosition-style write subtracts the offset, yielding eye-relative zero", () => {
        const cam = createArcRotateCamera(engine, 0, Math.PI / 2, 0.0001, { x: FAR, y: 0, z: FAR });
        cam._floatingOriginOffset = offset;
        const w = cam.worldMatrix;
        const eyeX = w[12]! - offset[0];
        const eyeY = w[13]! - offset[1];
        const eyeZ = w[14]! - offset[2];
        expect(Math.abs(eyeX)).toBeLessThan(1e-3);
        expect(Math.abs(eyeY)).toBeLessThan(1e-3);
        expect(Math.abs(eyeZ)).toBeLessThan(1e-3);
    });
});
