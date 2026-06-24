import { describe, it, expect } from "vitest";

import { createXrCamera, updateXrCameraForView } from "../../../../packages/babylon-lite/src/xr/xr-camera";
import { getViewMatrix, getProjectionMatrix, getViewProjectionMatrix } from "../../../../packages/babylon-lite/src/camera/camera";
import type { NormalizedViewport } from "../../../../packages/babylon-lite/src/camera/camera";
import type { Mat4Storage } from "../../../../packages/babylon-lite/src/math/types";

/** Column-major view→world transform: identity rotation + translation. */
function poseMatrix(tx: number, ty: number, tz: number): Float32Array {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    m[12] = tx;
    m[13] = ty;
    m[14] = tz;
    return m;
}

/** A recognisable, non-symmetric projection matrix (so we can prove it is injected verbatim). */
function fakeProjection(): Float32Array {
    const p = new Float32Array(16);
    for (let i = 0; i < 16; i++) {
        p[i] = (i + 1) * 0.125;
    }
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

    it("derives the view matrix as the inverse of the eye pose", () => {
        const cam = createXrCamera("left");
        const pose = poseMatrix(2, -3, 5);
        updateXrCameraForView(cam, makeView("left", pose, fakeProjection()), rtW, rtH, viewport);

        const v = getViewMatrix(cam) as unknown as Mat4Storage;
        // Identity rotation → translation negated.
        expect(v[12]).toBeCloseTo(-2, 6);
        expect(v[13]).toBeCloseTo(3, 6);
        expect(v[14]).toBeCloseTo(-5, 6);
        expect(v[0]).toBeCloseTo(1, 6);
        expect(v[5]).toBeCloseTo(1, 6);
        expect(v[10]).toBeCloseTo(1, 6);
    });

    it("injects the per-eye projection verbatim for the render task's exact aspect", () => {
        const cam = createXrCamera("right");
        const proj = fakeProjection();
        updateXrCameraForView(cam, makeView("right", poseMatrix(0, 0, 0), proj), rtW, rtH, viewport);

        const p = getProjectionMatrix(cam, aspect) as unknown as Mat4Storage;
        for (let i = 0; i < 16; i++) {
            expect(p[i]).toBeCloseTo(proj[i]!, 6);
        }
    });

    it("composes view-projection from the injected caches (proj × view)", () => {
        const cam = createXrCamera("left");
        const pose = poseMatrix(1, 0, -4);
        const proj = fakeProjection();
        updateXrCameraForView(cam, makeView("left", pose, proj), rtW, rtH, viewport);

        const view = getViewMatrix(cam) as unknown as Float32Array;
        const expected = mat4Multiply(proj, view);
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
        // Verbatim injection means element [0] equals proj[0], not a recomputed perspective term.
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
