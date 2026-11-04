/**
 * `createBankedFreeCamera` — an opt-in FreeCamera whose look-at up vector is explicit
 * and mutable, so the camera can roll (Babylon.js `camera.upVector`).
 */

import { describe, expect, it } from "vitest";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera";
import { createBankedFreeCamera } from "../../../packages/babylon-lite/src/camera/banked-free-camera";
import { getViewMatrix } from "../../../packages/babylon-lite/src/camera/camera";

const EYE = { x: 0, y: 0, z: 0 };
const TARGET = { x: 0, y: 0, z: 1 };

describe("createBankedFreeCamera", () => {
    it("defaults to world +Y, producing the same world matrix as a plain FreeCamera", () => {
        const plain = createFreeCamera(EYE, TARGET);
        const banked = createBankedFreeCamera(EYE, TARGET);
        expect(Array.from(banked.worldMatrix)).toEqual(Array.from(plain.worldMatrix));
        expect(banked.upVector.x).toBe(0);
        expect(banked.upVector.y).toBe(1);
        expect(banked.upVector.z).toBe(0);
    });

    it("builds its basis against the supplied up vector", () => {
        // Rolled 90 degrees: up = +X ⇒ the camera's right axis becomes -Y.
        const banked = createBankedFreeCamera(EYE, TARGET, { x: 1, y: 0, z: 0 });
        const w = banked.worldMatrix;
        expect(w[0]).toBeCloseTo(0, 12);
        expect(w[1]).toBeCloseTo(-1, 12);
        expect(w[2]).toBeCloseTo(0, 12);
        expect(w[4]).toBeCloseTo(1, 12);
        expect(w[5]).toBeCloseTo(0, 12);
        expect(w[8]).toBeCloseTo(0, 12);
        expect(w[10]).toBeCloseTo(1, 12);
    });

    it("invalidates the world matrix when the up vector is mutated", () => {
        const banked = createBankedFreeCamera(EYE, TARGET);
        const before = banked.worldMatrixVersion;
        expect(banked.worldMatrix[4]).toBeCloseTo(0, 12);
        expect(banked.worldMatrix[5]).toBeCloseTo(1, 12);
        banked.upVector.set(1, 0, 0);
        expect(banked.worldMatrixVersion).not.toBe(before);
        expect(banked.worldMatrix[4]).toBeCloseTo(1, 12);
        expect(banked.worldMatrix[5]).toBeCloseTo(0, 12);
    });

    it("keeps the up vector out of the derived view matrix translation", () => {
        const banked = createBankedFreeCamera({ x: 2, y: 3, z: 4 }, { x: 2, y: 3, z: 9 }, { x: 0, y: 1, z: 0 });
        const view = getViewMatrix(banked);
        expect(view[12]).toBeCloseTo(-2, 12);
        expect(view[13]).toBeCloseTo(-3, 12);
        expect(view[14]).toBeCloseTo(-4, 12);
    });

    it("falls back to an identity rotation for a degenerate up, like createFreeCamera", () => {
        const banked = createBankedFreeCamera(EYE, TARGET, { x: 0, y: 0, z: 1 });
        const w = banked.worldMatrix;
        expect(w[0]).toBe(1);
        expect(w[5]).toBe(1);
        expect(w[10]).toBe(1);
    });

    it("keeps a plain FreeCamera free of an up vector", () => {
        const plain = createFreeCamera(EYE, TARGET) as unknown as { upVector?: unknown };
        expect(plain.upVector).toBeUndefined();
    });
});
