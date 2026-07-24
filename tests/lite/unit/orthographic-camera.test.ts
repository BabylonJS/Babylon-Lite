import { describe, expect, it } from "vitest";
import { getProjectionMatrix, type Camera } from "../../../packages/babylon-lite/src/camera/camera";
import { disableOrthographicCamera, enableOrthographicCamera } from "../../../packages/babylon-lite/src/camera/orthographic";
import { mat4OrthoOffCenterLHToRef } from "../../../packages/babylon-lite/src/math/mat4-ortho-lh-to-ref";
import type { Mat4, Mat4Storage } from "../../../packages/babylon-lite/src/math/types";

/** Minimal `Camera` stand-in — the projection path only reads fov/near/far/`_ortho` and the caches. */
function makeCamera(): Camera {
    return {
        fov: 0.8,
        nearPlane: 1,
        farPlane: 100,
        children: [],
        worldMatrix: new Float32Array(16) as unknown as Mat4,
        worldMatrixVersion: 1,
        _viewCache: new Float32Array(16) as unknown as Mat4Storage,
        _projCache: new Float32Array(16) as unknown as Mat4Storage,
        _vpCache: new Float32Array(16) as unknown as Mat4Storage,
    } as Camera;
}

/** Project a view-space point through a column-major matrix and divide by w. */
function project(m: Mat4, x: number, y: number, z: number): [number, number, number] {
    const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    const cz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    return [cx / cw, cy / cw, cz / cw];
}

describe("orthographic projection", () => {
    it("maps the view volume corners to NDC with reverse-Z depth", () => {
        const m = new Float32Array(16) as unknown as Mat4Storage;
        mat4OrthoOffCenterLHToRef(m, -8, 8, -4.5, 4.5, 1, 101);
        const p = m as unknown as Mat4;

        // near -> 1, far -> 0 (reverse-Z, matching mat4PerspectiveLHToRef).
        expect(project(p, 0, 0, 1)[2]).toBeCloseTo(1, 5);
        expect(project(p, 0, 0, 101)[2]).toBeCloseTo(0, 5);

        // x/y map linearly and, unlike perspective, do not depend on depth.
        expect(project(p, 8, 4.5, 1)).toEqual([expect.closeTo(1, 5), expect.closeTo(1, 5), expect.closeTo(1, 5)]);
        expect(project(p, -8, -4.5, 101)).toEqual([expect.closeTo(-1, 5), expect.closeTo(-1, 5), expect.closeTo(0, 5)]);
        expect(project(p, 4, 2.25, 5)[0]).toBeCloseTo(project(p, 4, 2.25, 90)[0], 5);
    });

    it("keeps an off-center volume centred on its own midpoint", () => {
        const m = new Float32Array(16) as unknown as Mat4Storage;
        mat4OrthoOffCenterLHToRef(m, 2, 10, -1, 3, 1, 11);
        const [ndcX, ndcY] = project(m as unknown as Mat4, 6, 1, 5);
        expect(ndcX).toBeCloseTo(0, 5);
        expect(ndcY).toBeCloseTo(0, 5);
    });

    it("derives the horizontal extent from the aspect ratio", () => {
        const camera = makeCamera();
        enableOrthographicCamera(camera, { halfHeight: 6 });
        const p = getProjectionMatrix(camera, 2);
        // halfWidth = 6 * 2 = 12, halfHeight = 6.
        expect(project(p, 12, 6, camera.nearPlane)).toEqual([expect.closeTo(1, 5), expect.closeTo(1, 5), expect.closeTo(1, 5)]);
    });

    it("reverts cleanly to perspective, leaving no stale ortho terms", () => {
        const camera = makeCamera();
        enableOrthographicCamera(camera, { halfHeight: 6 });
        getProjectionMatrix(camera, 1.5);

        disableOrthographicCamera(camera);
        const p = getProjectionMatrix(camera, 1.5);
        // Perspective divides by view-space z: the projected x of a fixed point must shrink with depth.
        expect(p[11]).toBe(1);
        expect(p[15]).toBe(0);
        expect(Math.abs(project(p, 3, 0, 50)[0])).toBeLessThan(Math.abs(project(p, 3, 0, 10)[0]));
    });

    it("re-arms the projection cache on every enable so extents can change at runtime", () => {
        const camera = makeCamera();
        enableOrthographicCamera(camera, { halfHeight: 6 });
        expect(project(getProjectionMatrix(camera, 1), 0, 6, camera.nearPlane)[1]).toBeCloseTo(1, 5);

        enableOrthographicCamera(camera, { halfHeight: 3 });
        expect(project(getProjectionMatrix(camera, 1), 0, 6, camera.nearPlane)[1]).toBeCloseTo(2, 5);
    });
});
