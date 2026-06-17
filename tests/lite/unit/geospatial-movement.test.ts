import { describe, expect, it } from "vitest";

import {
    frameDecay,
    integrateInertialVelocity,
    computePanSpeedMultiplier,
    computeZoomSpeedMultiplier,
    REFERENCE_FRAME_RATE,
} from "../../../packages/babylon-lite/src/camera/geospatial-movement";
import type { Vec3 } from "../../../packages/babylon-lite/src/math/types";

const REF_MS = 1000 / REFERENCE_FRAME_RATE;

describe("frameDecay", () => {
    it("is the identity at the reference frame time and 1 for a zero-length frame", () => {
        expect(frameDecay(0.9, REF_MS)).toBeCloseTo(0.9, 9);
        expect(frameDecay(0.9, 0)).toBe(1); // x^0 = 1
    });

    it("is frame-rate normalized: a double-length frame decays like two frames", () => {
        const single = frameDecay(0.9, REF_MS);
        const doubleFrame = frameDecay(0.9, 2 * REF_MS);
        expect(doubleFrame).toBeCloseTo(single * single, 12);
    });
});

describe("integrateInertialVelocity", () => {
    it("decays velocity by frameDecay when there is no input", () => {
        const v = integrateInertialVelocity(10, 0, 0.9, REF_MS, false);
        expect(v).toBeCloseTo(9, 9);
    });

    it("returns the velocity unchanged for a zero-length frame", () => {
        expect(integrateInertialVelocity(7, 100, 0.9, 0, true)).toBe(7);
    });

    it("snaps a tiny coasting velocity to exactly 0 (no input)", () => {
        expect(integrateInertialVelocity(1e-7, 0, 0.9, REF_MS, false)).toBe(0);
    });

    it("decay is frame-rate independent over equal wall-clock time", () => {
        // Two 16.67 ms steps vs one 33.33 ms step, starting from the same velocity.
        const oneStep = integrateInertialVelocity(100, 0, 0.9, 2 * REF_MS, false);
        const twoSteps = integrateInertialVelocity(integrateInertialVelocity(100, 0, 0.9, REF_MS, false), 0, 0.9, REF_MS, false);
        expect(twoSteps).toBeCloseTo(oneStep, 9);
    });

    it("injects fresh pixel input on top of the decayed velocity", () => {
        const decayedOnly = integrateInertialVelocity(10, 0, 0.9, REF_MS, false);
        const withInput = integrateInertialVelocity(10, 30, 0.9, REF_MS, false);
        expect(withInput).toBeGreaterThan(decayedOnly);
    });
});

describe("computePanSpeedMultiplier", () => {
    it("is 1 at the equator close to the surface (no damping)", () => {
        const center: Vec3 = { x: 100, y: 0, z: 0 };
        const position: Vec3 = { x: 110, y: 0, z: 0 };
        expect(computePanSpeedMultiplier(center, position)).toBeCloseTo(1, 9);
    });

    it("applies sqrt(cos(lat)) latitude damping when altitude scale is 1", () => {
        // sin(lat) = 0.8 → cos(lat) = 0.6; height == centreRadius so altitudeScale = 1.
        const center: Vec3 = { x: 60, y: 0, z: 80 }; // mag 100
        const position: Vec3 = { x: 120, y: 0, z: 160 }; // mag 200, height 100
        const expected = Math.sqrt(0.6); // sqrt(|cos lat|), cos lat = 0.6
        expect(computePanSpeedMultiplier(center, position)).toBeCloseTo(expected, 6);
    });

    it("pans slower at high latitude than at the equator for the same altitude", () => {
        const equatorCenter: Vec3 = { x: 100, y: 0, z: 0 };
        const equatorPos: Vec3 = { x: 200, y: 0, z: 0 };
        const polarCenter: Vec3 = { x: 60, y: 0, z: 80 };
        const polarPos: Vec3 = { x: 120, y: 0, z: 160 };
        expect(computePanSpeedMultiplier(polarCenter, polarPos)).toBeLessThan(computePanSpeedMultiplier(equatorCenter, equatorPos));
    });
});

describe("computeZoomSpeedMultiplier", () => {
    it("scales linearly with distance to the target (0.01×)", () => {
        expect(computeZoomSpeedMultiplier(500)).toBeCloseTo(5, 9);
        expect(computeZoomSpeedMultiplier(0)).toBe(0);
    });
});
