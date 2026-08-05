import { describe, it, expect } from "vitest";

import { createXrCamera, updateXrCameraForView } from "../../../../packages/babylon-lite/src/xr/xr-camera";
import { getViewMatrix, getProjectionMatrix, getViewProjectionMatrix } from "../../../../packages/babylon-lite/src/camera/camera";
import type { NormalizedViewport } from "../../../../packages/babylon-lite/src/camera/camera";
import type { Mat4Storage } from "../../../../packages/babylon-lite/src/math/types";
import { mat4PerspectiveLHToRef } from "../../../../packages/babylon-lite/src/math/mat4-perspective-lh-to-ref";

/** Column-major view→world transform: identity rotation + translation. */
function poseMatrix(tx: number, ty: number, tz: number): Float32Array {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    m[12] = tx;
    m[13] = ty;
    m[14] = tz;
    return m;
}

/** A recognisable, non-symmetric projection matrix (so we can prove it is injected). */
function fakeProjection(): Float32Array {
    const p = new Float32Array(16);
    for (let i = 0; i < 16; i++) {
        p[i] = (i + 1) * 0.125;
    }
    return p;
}

/** A right-handed, z∈[0,1] perspective exactly as the WebGPU XR binding reports it
 *  (glMatrix `perspectiveZO`, camera looking down −z). Column-major. */
function rhZeroToOnePerspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    const p = new Float32Array(16);
    p[0] = f / aspect;
    p[5] = f;
    p[10] = far * nf;
    p[11] = -1;
    p[14] = far * near * nf;
    return p;
}

/** Replicates xr-camera's projection conversion (RH→LH toggle + reverse-Z remap). */
function convertProjection(pm: Float32Array): Float32Array {
    const p = new Float32Array(pm);
    p[8] = -p[8]!;
    p[9] = -p[9]!;
    p[10] = -p[10]!;
    p[11] = -p[11]!;
    p[2] = p[3]! - p[2]!;
    p[6] = p[7]! - p[6]!;
    p[10] = p[11]! - p[10]!;
    p[14] = p[15]! - p[14]!;
    return p;
}

function makeView(eye: XREye, pose: Float32Array, proj: Float32Array): XRView {
    return {
        eye,
        transform: { matrix: pose } as XRRigidTransform,
        projectionMatrix: proj,
    } as unknown as XRView;
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
    // out = a * b, column-major (matches mat4MultiplyInto semantics: proj * view)
    const out = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let s = 0;
            for (let k = 0; k < 4; k++) {
                s += a[row + k * 4]! * b[k + col * 4]!;
            }
            out[row + col * 4] = s;
        }
    }
    return out;
}

describe("xr-camera matrix injection", () => {
    const rtW = 1024;
    const rtH = 1024;
    const viewport: NormalizedViewport = { x: 0, y: 0, width: 0.5, height: 1 };
    const aspect = (rtW / rtH) * (viewport.width / viewport.height);

    it("derives the view matrix as the inverse of the left-handed eye pose", () => {
        const cam = createXrCamera("left");
        const pose = poseMatrix(2, -3, 5);
        updateXrCameraForView(cam, makeView("left", pose, fakeProjection()), rtW, rtH, viewport);

        const v = getViewMatrix(cam) as unknown as Mat4Storage;
        // Right→left handed toggle negates the pose's Z translation (5 → −5); the view
        // matrix is its inverse, so the Z translation flips back to +5.
        expect(v[12]).toBeCloseTo(-2, 6);
        expect(v[13]).toBeCloseTo(3, 6);
        expect(v[14]).toBeCloseTo(5, 6);
        expect(v[0]).toBeCloseTo(1, 6);
        expect(v[5]).toBeCloseTo(1, 6);
        expect(v[10]).toBeCloseTo(1, 6);
    });

    it("converts a right-handed WebXR pose to a proper left-handed rigid transform", () => {
        // Pose: 90° rotation about Y (right-handed) with a translation.
        const c = Math.cos(Math.PI / 2);
        const s = Math.sin(Math.PI / 2);
        const pose = new Float32Array(16);
        // Column-major RH rotation about +Y.
        pose[0] = c;
        pose[2] = -s;
        pose[8] = s;
        pose[10] = c;
        pose[5] = 1;
        pose[15] = 1;
        pose[12] = 1;
        pose[13] = 2;
        pose[14] = 3;
        const cam = createXrCamera("left");
        updateXrCameraForView(cam, makeView("left", pose, fakeProjection()), rtW, rtH, viewport);
        const w = cam._world as unknown as Float32Array;
        // The 3×3 rotation must remain orthonormal with determinant +1 (proper LH rotation),
        // otherwise getViewMatrix's transpose-inverse would be wrong and winding would flip.
        const det = w[0]! * (w[5]! * w[10]! - w[6]! * w[9]!) - w[4]! * (w[1]! * w[10]! - w[2]! * w[9]!) + w[8]! * (w[1]! * w[6]! - w[2]! * w[5]!);
        expect(det).toBeCloseTo(1, 5);
        // Z translation is negated by the handedness toggle.
        expect(w[14]).toBeCloseTo(-3, 6);
    });

    it("injects the per-eye projection with handedness + reverse-Z conversion", () => {
        const cam = createXrCamera("right");
        const proj = fakeProjection();
        updateXrCameraForView(cam, makeView("right", poseMatrix(0, 0, 0), proj), rtW, rtH, viewport);

        const p = getProjectionMatrix(cam, aspect) as unknown as Mat4Storage;
        const expected = convertProjection(proj);
        for (let i = 0; i < 16; i++) {
            expect(p[i]).toBeCloseTo(expected[i]!, 6);
        }
    });

    it("turns a right-handed [0,1] WebXR perspective into Babylon Lite's reverse-Z LH projection", () => {
        // The whole point of the conversion: a WebGPU-binding projection (RH, z∈[0,1])
        // must become exactly what the engine's own perspective builder produces (LH,
        // reverse-Z, z∈[1,0]) so culling and the depth test both work unchanged.
        const fovy = 1.2;
        const near = 0.1;
        const far = 100;
        const rhProj = rhZeroToOnePerspective(fovy, 1, near, far);
        const cam = createXrCamera("left");
        // Square viewport so the injected aspect matches the projection's own aspect (1).
        const squareVp: NormalizedViewport = { x: 0, y: 0, width: 1, height: 1 };
        updateXrCameraForView(cam, makeView("left", poseMatrix(0, 0, 0), rhProj), 1024, 1024, squareVp);

        const p = getProjectionMatrix(cam, 1) as unknown as Mat4Storage;
        const lite = new Float32Array(16);
        mat4PerspectiveLHToRef(lite as unknown as Mat4Storage, fovy, 1, near, far);
        for (let i = 0; i < 16; i++) {
            expect(p[i]).toBeCloseTo(lite[i]!, 5);
        }
    });

    it("composes view-projection from the injected caches (proj × view)", () => {
        const cam = createXrCamera("left");
        const pose = poseMatrix(1, 0, -4);
        const proj = fakeProjection();
        updateXrCameraForView(cam, makeView("left", pose, proj), rtW, rtH, viewport);

        const view = getViewMatrix(cam) as unknown as Float32Array;
        const projConv = getProjectionMatrix(cam, aspect) as unknown as Float32Array;
        const expected = mat4Multiply(projConv, view);
        const vp = getViewProjectionMatrix(cam, aspect) as unknown as Mat4Storage;
        for (let i = 0; i < 16; i++) {
            expect(vp[i]).toBeCloseTo(expected[i]!, 4);
        }
    });

    it("uses an aspect bit-identical to the render task formula", () => {
        const cam = createXrCamera("left");
        const proj = fakeProjection();
        // Asymmetric per-eye viewport (left half of a side-by-side texture).
        const vpHalf: NormalizedViewport = { x: 0, y: 0, width: 0.5, height: 1 };
        updateXrCameraForView(cam, makeView("left", poseMatrix(0, 0, 0), proj), 2000, 1000, vpHalf);

        // Render task: aspect = (rt._width / rt._height) * (v.width / v.height)
        const taskAspect = (2000 / 1000) * (vpHalf.width / vpHalf.height);
        const p = getProjectionMatrix(cam, taskAspect) as unknown as Mat4Storage;
        // m[0] is untouched by the conversion, so it stays the injected XR value.
        expect(p[0]).toBe(proj[0]);
        expect(cam.viewport).toBe(vpHalf);
    });

    it("bumps the world-matrix version each update so caches invalidate", () => {
        const cam = createXrCamera("left");
        const v0 = cam.worldMatrixVersion;
        updateXrCameraForView(cam, makeView("left", poseMatrix(0, 0, 0), fakeProjection()), rtW, rtH, viewport);
        const v1 = cam.worldMatrixVersion;
        updateXrCameraForView(cam, makeView("left", poseMatrix(1, 1, 1), fakeProjection()), rtW, rtH, viewport);
        const v2 = cam.worldMatrixVersion;
        expect(v1).not.toBe(v0);
        expect(v2).not.toBe(v1);
    });
});
