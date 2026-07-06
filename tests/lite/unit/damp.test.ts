import { describe, expect, it } from "vitest";

import { expDampFactor, dampScalar, lerpAngleShortest } from "../../../packages/babylon-lite/src/math/damp";

describe("expDampFactor", () => {
    it("returns 0 for a zero-length frame", () => {
        expect(expDampFactor(0, 0.1)).toBe(0);
    });

    it("returns 0 for a negative frame delta (never moves the value backwards)", () => {
        expect(expDampFactor(-0.016, 0.1)).toBe(0);
        expect(expDampFactor(-1, 0.1)).toBe(0);
    });

    it("returns 1 immediately when the factor is non-positive", () => {
        expect(expDampFactor(0.016, 0)).toBe(1);
        expect(expDampFactor(0.016, -1)).toBe(1);
    });

    it("produces a weight in [0, 1) that grows with elapsed time", () => {
        const small = expDampFactor(0.016, 0.1);
        const large = expDampFactor(0.5, 0.1);
        expect(small).toBeGreaterThan(0);
        expect(small).toBeLessThan(1);
        expect(large).toBeGreaterThan(small);
        expect(large).toBeLessThan(1);
    });

    it("is frame-rate independent: two half-steps compose to one full step", () => {
        const factor = 0.1;
        // Approaching a goal of 1 from 0. One 0.032s step vs two 0.016s steps should land at the same place.
        const oneStep = dampScalar(0, 1, expDampFactor(0.032, factor));

        let v = 0;
        v = dampScalar(v, 1, expDampFactor(0.016, factor));
        v = dampScalar(v, 1, expDampFactor(0.016, factor));

        expect(v).toBeCloseTo(oneStep, 6);
    });
});

describe("dampScalar", () => {
    it("interpolates linearly by t", () => {
        expect(dampScalar(0, 10, 0)).toBe(0);
        expect(dampScalar(0, 10, 1)).toBe(10);
        expect(dampScalar(0, 10, 0.25)).toBe(2.5);
    });
});

describe("lerpAngleShortest", () => {
    it("interpolates within a small range like a plain lerp", () => {
        expect(lerpAngleShortest(0, 1, 0.5)).toBeCloseTo(0.5, 6);
    });

    it("takes the short way across the +/-PI wrap boundary", () => {
        // 3.0 -> -3.0 is +(2*PI - 6) rad the short way (through PI), not -6.0 the long way,
        // so a partial step must move in the positive direction (past 3.0), not toward 0.
        const result = lerpAngleShortest(3.0, -3.0, 0.5);
        expect(result).toBeGreaterThan(3.0);
    });

    it("lands exactly on the goal delta at t=1 (usable to recover shortest signed delta)", () => {
        // The adapter relies on lerpAngleShortest(current, goal, 1) - current == shortest signed delta.
        const current = 3.0;
        const goal = -3.0;
        const delta = lerpAngleShortest(current, goal, 1) - current;
        // Shortest signed delta from 3.0 to -3.0 is +2*PI - 6 ≈ 0.2832.
        expect(delta).toBeCloseTo(2 * Math.PI - 6, 6);
    });

    it("handles goals more than PI away in the negative direction", () => {
        const delta = lerpAngleShortest(-3.0, 3.0, 1) - -3.0;
        expect(delta).toBeCloseTo(-(2 * Math.PI - 6), 6);
    });
});
