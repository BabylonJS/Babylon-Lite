import { describe, expect, it, beforeEach } from "vitest";

import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera";
import { getProjectionMatrix, getViewProjectionMatrix } from "../../../packages/babylon-lite/src/camera/camera";
import { _resetMatrixAllocatorForTests } from "../../../packages/babylon-lite/src/math/_matrix-allocator";

// Regression coverage for issue #271: mutating the public projection fields
// (`fov`, `nearPlane`, `farPlane`) must invalidate the projection /
// view-projection caches immediately — without needing the camera to move
// first. The projection matrix is a pure function of (fov, aspect, near, far)
// and never depends on the world matrix, so the cache is keyed on those inputs.

const ASPECT = 16 / 9;

/** Copy a matrix's elements out (the caches are mutated in place and returned by reference). */
function snapshot(m: ArrayLike<number>): number[] {
    return Array.from(m as unknown as number[]);
}

describe("camera projection cache invalidation (#271)", () => {
    beforeEach(() => {
        _resetMatrixAllocatorForTests();
    });

    it("recomputes the projection matrix when fov changes on a stationary camera", () => {
        const camera = createFreeCamera({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 0 });
        const versionBefore = camera.worldMatrixVersion;

        const first = snapshot(getProjectionMatrix(camera, ASPECT));

        camera.fov = camera.fov + 0.5;
        const second = snapshot(getProjectionMatrix(camera, ASPECT));

        // The camera never moved: worldMatrixVersion is unchanged, yet the
        // projection must reflect the new fov (element [5] == 1/tan(fov/2)).
        expect(camera.worldMatrixVersion).toBe(versionBefore);
        expect(second[5]).not.toBe(first[5]);
    });

    it("recomputes the projection matrix when nearPlane / farPlane change", () => {
        const camera = createFreeCamera({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 0 });

        const first = snapshot(getProjectionMatrix(camera, ASPECT));

        camera.nearPlane = camera.nearPlane + 2;
        camera.farPlane = camera.farPlane * 0.5;
        const second = snapshot(getProjectionMatrix(camera, ASPECT));

        // Elements [10] and [14] encode the near/far depth mapping.
        expect(second[10]).not.toBe(first[10]);
        expect(second[14]).not.toBe(first[14]);
    });

    it("returns a stable projection matrix when nothing changes", () => {
        const camera = createFreeCamera({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 0 });

        const first = snapshot(getProjectionMatrix(camera, ASPECT));
        const second = snapshot(getProjectionMatrix(camera, ASPECT));

        expect(second).toEqual(first);
    });

    it("recomputes the projection matrix when the aspect ratio changes", () => {
        const camera = createFreeCamera({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 0 });

        const first = snapshot(getProjectionMatrix(camera, ASPECT));
        const second = snapshot(getProjectionMatrix(camera, 1));

        // Element [0] == (1/tan(fov/2)) / aspect.
        expect(second[0]).not.toBe(first[0]);
    });

    it("propagates a fov change through the view-projection matrix on a stationary camera", () => {
        const camera = createFreeCamera({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 0 });
        const versionBefore = camera.worldMatrixVersion;

        const first = snapshot(getViewProjectionMatrix(camera, ASPECT));

        camera.fov = camera.fov + 0.5;
        const second = snapshot(getViewProjectionMatrix(camera, ASPECT));

        expect(camera.worldMatrixVersion).toBe(versionBefore);
        expect(second).not.toEqual(first);
    });
});
