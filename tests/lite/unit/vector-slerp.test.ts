import { describe, expect, it } from "vitest";

import { slerpVec3ToRef } from "../../../packages/babylon-lite/src/math/slerp-vec3-to-ref";

describe("slerpVec3ToRef", () => {
    it("rotates exactly opposite vectors without collapsing their magnitude", () => {
        const start = { x: 0, y: 2, z: 0 };
        const end = { x: 0, y: -2, z: 0 };
        const result = { x: 0, y: 0, z: 0 };

        for (const amount of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
            expect(slerpVec3ToRef(start, end, amount, result)).toBe(result);
            expect(Math.hypot(result.x, result.y, result.z)).toBeCloseTo(2);
            expect(result.y / 2).toBeCloseTo(Math.cos(amount * Math.PI));
        }

        expect(result).toEqual(end);
        expect(start).toEqual({ x: 0, y: 2, z: 0 });
        expect(end).toEqual({ x: 0, y: -2, z: 0 });
    });

    it("stays on the unit sphere for nearly opposite vectors", () => {
        const start = { x: 1, y: 0, z: 0 };
        const endLength = Math.hypot(-1, 1e-9, 0);
        const end = { x: -1 / endLength, y: 1e-9 / endLength, z: 0 };
        const result = { x: 0, y: 0, z: 0 };

        for (const amount of [0.25, 0.5, 0.75]) {
            slerpVec3ToRef(start, end, amount, result);
            expect(Math.hypot(result.x, result.y, result.z)).toBeCloseTo(1);
            expect(result.x).toBeCloseTo(Math.cos(amount * Math.PI));
            expect(result.y).toBeCloseTo(Math.sin(amount * Math.PI));
        }
    });

    it("interpolates magnitude and clamps the interpolation amount", () => {
        const result = { x: 0, y: 0, z: 0 };
        slerpVec3ToRef({ x: 2, y: 0, z: 0 }, { x: 0, y: 4, z: 0 }, 0.5, result);
        expect(Math.hypot(result.x, result.y, result.z)).toBeCloseTo(3);
        expect(result.x).toBeCloseTo(3 * Math.SQRT1_2);
        expect(result.y).toBeCloseTo(3 * Math.SQRT1_2);

        slerpVec3ToRef({ x: 2, y: 0, z: 0 }, { x: 0, y: 4, z: 0 }, -1, result);
        expect(result).toEqual({ x: 2, y: 0, z: 0 });
        slerpVec3ToRef({ x: 2, y: 0, z: 0 }, { x: 0, y: 4, z: 0 }, 2, result);
        expect(result.x).toBeCloseTo(0);
        expect(result.y).toBeCloseTo(4);
        expect(result.z).toBeCloseTo(0);
    });

    it("matches Babylon.js length arithmetic for subnormal vectors", () => {
        const result = { x: 0, y: 0, z: 0 };
        slerpVec3ToRef({ x: Number.MIN_VALUE, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0.5, result);
        expect(result.x).toBeCloseTo(Math.SQRT1_2 * 0.5);
        expect(result.y).toBe(0);
        expect(result.z).toBe(0);
    });
});
