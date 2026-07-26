import { describe, expect, it } from "vitest";
import { getProjectionMatrix, getViewProjectionMatrix, type Camera } from "../../../packages/babylon-lite/src/camera/camera";
import { createArcRotateCamera, type ArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import { disableOrthographicCamera, enableOrthographicCamera } from "../../../packages/babylon-lite/src/camera/orthographic";
import { mat4OrthoOffCenterLHToRef } from "../../../packages/babylon-lite/src/math/mat4-ortho-lh-to-ref";
import type { Mat4, Mat4Storage } from "../../../packages/babylon-lite/src/math/types";

/** Minimal `Camera` stand-in — the projection path only reads near/far/fov/`ortho` and the
 *  caches. The world matrix is identity so the derived view matrix is identity too, which
 *  lets the view-projection assertions read the projection directly. */
function makeCamera(): Camera {
    const world = new Float32Array(16);
    world[0] = world[5] = world[10] = world[15] = 1;
    return {
        fov: 0.8,
        nearPlane: 1,
        farPlane: 100,
        children: [],
        worldMatrix: world as unknown as Mat4,
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

    it("applies live mutations of the bounds without moving the camera", () => {
        const camera = makeCamera();
        const ortho = enableOrthographicCamera(camera, { halfHeight: 6 });
        expect(project(getProjectionMatrix(camera, 1), 0, 6, camera.nearPlane)[1]).toBeCloseTo(1, 5);

        // The projection cache is keyed on worldMatrixVersion + aspect, neither of which
        // changes here — the bounds setter must invalidate it on its own.
        ortho.halfHeight = 3;
        expect(project(getProjectionMatrix(camera, 1), 0, 6, camera.nearPlane)[1]).toBeCloseTo(2, 5);

        // Same object is reachable from the camera, and the view-projection cache follows too.
        expect(camera.ortho).toBe(ortho);
        camera.ortho!.halfHeight = 12;
        expect(project(getViewProjectionMatrix(camera, 1), 0, 6, camera.nearPlane)[1]).toBeCloseTo(0.5, 5);
    });

    it("switches a plane between derived and off-center by assigning null", () => {
        const camera = makeCamera();
        const ortho = enableOrthographicCamera(camera, { halfHeight: 4 });
        expect(project(getProjectionMatrix(camera, 1), 4, 0, camera.nearPlane)[0]).toBeCloseTo(1, 5);

        ortho.right = 8;
        expect(project(getProjectionMatrix(camera, 1), 8, 0, camera.nearPlane)[0]).toBeCloseTo(1, 5);

        ortho.right = null;
        expect(project(getProjectionMatrix(camera, 1), 4, 0, camera.nearPlane)[0]).toBeCloseTo(1, 5);
    });

    it("exposes every bound as an own enumerable property so animation paths resolve", () => {
        const camera = makeCamera();
        const ortho = enableOrthographicCamera(camera);
        // `resolvePropertyBinding` walks the path with `in` and writes `target[prop] = value`,
        // so an animation targeting "ortho.halfHeight" needs the key to exist up front.
        for (const key of ["halfHeight", "left", "right", "bottom", "top"]) {
            expect(key in ortho, `"${key}" must be present for animation path resolution`).toBe(true);
        }
        expect(Object.keys(ortho)).toEqual(["halfHeight", "left", "right", "bottom", "top"]);

        // Simulate the animation writer's plain assignment.
        (ortho as unknown as Record<string, number>)["halfHeight"] = 5;
        expect(project(getProjectionMatrix(camera, 1), 0, 5, camera.nearPlane)[1]).toBeCloseTo(1, 5);
    });

    it("keeps halfHeight number-only so the derived extents cannot go NaN", () => {
        const camera = makeCamera();
        const ortho = enableOrthographicCamera(camera, { halfHeight: 4 });
        // `null` is meaningful on the planes (derive from halfHeight) but would multiply
        // through into a degenerate projection if accepted on halfHeight itself.
        ortho.left = null;
        expect(ortho.left).toBeNull();
        expect(Number.isFinite(ortho.halfHeight)).toBe(true);
        expect(Number.isFinite(project(getProjectionMatrix(camera, 1.5), 0, 0, camera.nearPlane)[2])).toBe(true);
    });
});

/**
 * Regression coverage for the steady-state upload path.
 *
 * Per-frame consumers do not call `getProjectionMatrix` unconditionally — the forward pass's
 * scene UBO writer gates on `[camera, fog, worldMatrixVersion, aspect, envRotationY, exposure,
 * contrast, envTextures]` and returns early when they all match the previous frame. Mutating a
 * view volume moves none of those, so clearing `_projVer` / `_vpVer` alone would leave the GPU
 * rendering the stale view-projection forever. These tests use a real camera (the version
 * counter lives in its world-matrix state) and assert on `worldMatrixVersion`, which is the
 * exact input those gates key on.
 */
describe("orthographic projection — steady-state invalidation", () => {
    /** Mirror of the `_writePassSceneUBO` early-out, reduced to the camera-dependent inputs. */
    function makeUboGate(camera: ArcRotateCamera, aspect: number) {
        let lastCamera: unknown = null;
        let lastVersion = -1;
        let lastAspect = -1;
        return function wouldRewriteSceneUbo(): boolean {
            const wv = camera.worldMatrixVersion;
            if (lastCamera === camera && lastVersion === wv && lastAspect === aspect) {
                return false;
            }
            lastCamera = camera;
            lastVersion = wv;
            lastAspect = aspect;
            return true;
        };
    }

    it("re-uploads the scene UBO when a bound changes after steady state", () => {
        const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 30, { x: 0, y: 0, z: 0 });
        const ortho = enableOrthographicCamera(camera, { halfHeight: 6 });
        const wouldRewriteSceneUbo = makeUboGate(camera, 16 / 9);

        expect(wouldRewriteSceneUbo(), "first frame always writes").toBe(true);
        expect(wouldRewriteSceneUbo(), "steady state skips the write").toBe(false);

        ortho.halfHeight = 3;
        expect(wouldRewriteSceneUbo(), "a zoom change must reach the GPU").toBe(true);

        ortho.left = -20;
        expect(wouldRewriteSceneUbo(), "an explicit plane must reach the GPU").toBe(true);

        ortho.left = null;
        expect(wouldRewriteSceneUbo(), "returning a plane to derived must reach the GPU").toBe(true);
    });

    it("re-uploads the scene UBO when ortho is toggled after steady state", () => {
        const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 30, { x: 0, y: 0, z: 0 });
        const wouldRewriteSceneUbo = makeUboGate(camera, 16 / 9);
        expect(wouldRewriteSceneUbo()).toBe(true);
        expect(wouldRewriteSceneUbo()).toBe(false);

        enableOrthographicCamera(camera, { halfHeight: 6 });
        expect(wouldRewriteSceneUbo(), "runtime enable must reach the GPU").toBe(true);
        expect(wouldRewriteSceneUbo()).toBe(false);

        disableOrthographicCamera(camera);
        expect(wouldRewriteSceneUbo(), "runtime disable must reach the GPU").toBe(true);
    });

    it("does not disturb the camera transform when only the volume changes", () => {
        const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 30, { x: 0, y: 0, z: 0 });
        const ortho = enableOrthographicCamera(camera, { halfHeight: 6 });
        const before = Array.from(camera.worldMatrix as unknown as Float32Array);

        ortho.halfHeight = 2;

        expect(Array.from(camera.worldMatrix as unknown as Float32Array)).toEqual(before);
    });

    it("does not bump the version when a bound is assigned its current value", () => {
        const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 30, { x: 0, y: 0, z: 0 });
        const ortho = enableOrthographicCamera(camera, { halfHeight: 6 });
        const version = camera.worldMatrixVersion;

        ortho.halfHeight = 6;
        ortho.left = null;

        expect(camera.worldMatrixVersion).toBe(version);
    });
});
