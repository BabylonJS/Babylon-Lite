/**
 * The shadow camera facade does not *compute* its matrices through `camera.ts` — the shadow
 * task builds the light's view / view-projection (an orthographic or spot volume that
 * `getProjectionMatrix` knows nothing about) and installs them, pinning the cache versions so
 * the getters hand them straight back.
 *
 * That pin has to use the same key each getter compares against. `updateShadowCameraBase`
 * writes `nearPlane` / `farPlane` on every update, which moves the camera's projection
 * revision — so pinning the view-projection to the raw camera version instead of
 * `_cameraChangeKey` makes the getter miss and silently rebuild a *perspective* projection
 * over the light's volume, wrecking every shadow in the frame.
 */
import { describe, expect, it } from "vitest";

import { getViewMatrix, getViewProjectionMatrix } from "../../../packages/babylon-lite/src/camera/camera";
import { createShadowCamera, updateShadowCameraBase } from "../../../packages/babylon-lite/src/shadow/shadow-base";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";

type ShadowGeneratorLight = Parameters<typeof createShadowCamera>[0];

function makeLight(): ShadowGeneratorLight {
    const world = new Float32Array(16);
    world[0] = world[5] = world[10] = world[15] = 1;
    return { _light: { worldMatrix: world as unknown as Mat4, worldMatrixVersion: 7 } } as unknown as ShadowGeneratorLight;
}

/** A light view-projection nothing resembling a perspective matrix, so a rebuild is obvious. */
function makeViewProj(seed: number): Float32Array {
    return new Float32Array(Array.from({ length: 16 }, (_, i) => seed + i));
}

describe("shadow camera facade", () => {
    it("hands back the installed view-projection after a depth-range change", () => {
        const camera = createShadowCamera(makeLight());
        const view = makeViewProj(100);
        const viewProj = makeViewProj(200);
        // Snapshot before reading: the facade installs these arrays *as* the caches, so a
        // cache miss rebuilds in place and comparing against the live array would tautologise.
        const expectedView = Array.from(view);
        const expectedViewProj = Array.from(viewProj);

        updateShadowCameraBase(camera, 1, 0.5, 250, view, viewProj);
        expect(Array.from(getViewProjectionMatrix(camera, 1) as unknown as Float32Array)).toEqual(expectedViewProj);
        expect(Array.from(getViewMatrix(camera) as unknown as Float32Array)).toEqual(expectedView);

        // A cascade split / scene-bounds refit changes near+far while the light has not moved.
        const view2 = makeViewProj(300);
        const viewProj2 = makeViewProj(400);
        const expectedView2 = Array.from(view2);
        const expectedViewProj2 = Array.from(viewProj2);
        updateShadowCameraBase(camera, 2, 40, 900, view2, viewProj2);
        expect(Array.from(getViewProjectionMatrix(camera, 1) as unknown as Float32Array)).toEqual(expectedViewProj2);
        expect(Array.from(getViewMatrix(camera) as unknown as Float32Array)).toEqual(expectedView2);
    });

    it("stays pinned across repeated reads within a frame", () => {
        const camera = createShadowCamera(makeLight());
        const viewProj = makeViewProj(500);
        const expected = Array.from(viewProj);
        updateShadowCameraBase(camera, 3, 1, 100, makeViewProj(600), viewProj);

        for (let i = 0; i < 3; i++) {
            expect(Array.from(getViewProjectionMatrix(camera, 1) as unknown as Float32Array)).toEqual(expected);
        }
    });
});
