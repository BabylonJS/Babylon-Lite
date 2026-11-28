import { describe, expect, it } from "vitest";

import { sampleArcThroughThreePoints, sampleCatmullRomSpline, sampleHermiteSpline } from "../../../../packages/babylon-lite/src/math/curve-splines";

describe("curve spline sampling", () => {
    it("samples Hermite endpoints and tangents", () => {
        const points = sampleHermiteSpline({ x: 0, y: 0, z: 0 }, { x: 2, y: 4, z: 0 }, { x: 4, y: 0, z: 2 }, { x: 2, y: -4, z: 0 }, 2);

        expect(points).toEqual([
            { x: 0, y: 0, z: 0 },
            { x: 2, y: 1, z: 1 },
            { x: 4, y: 0, z: 2 },
        ]);
    });

    it("samples an open Catmull-Rom spline through every control point", () => {
        const controls = [
            { x: 0, y: 0, z: 0 },
            { x: 1, y: 2, z: 0 },
            { x: 3, y: 2, z: 1 },
            { x: 4, y: 0, z: 1 },
        ];
        const points = sampleCatmullRomSpline(controls, 2);

        expect(points).toHaveLength(7);
        expect(points[0]).toEqual(controls[0]);
        expect(points[2]).toEqual(controls[1]);
        expect(points[4]).toEqual(controls[2]);
        expect(points[6]).toEqual(controls[3]);
        expect(points[3]).toEqual({ x: 2, y: 2.25, z: 0.5 });
    });

    it("wraps closed Catmull-Rom control points and repeats the first sample", () => {
        const controls = [
            { x: 0, y: 0, z: 0 },
            { x: 2, y: 0, z: 0 },
            { x: 2, y: 2, z: 0 },
            { x: 0, y: 2, z: 0 },
        ];
        const points = sampleCatmullRomSpline(controls, 2, true);

        expect(points).toHaveLength(9);
        expect(points[0]).toEqual(controls[1]);
        expect(points[2]).toEqual(controls[2]);
        expect(points[4]).toEqual(controls[3]);
        expect(points[6]).toEqual(controls[0]);
        expect(points[8]).toEqual(points[0]);
        expect(points[7]).toEqual({ x: 1, y: -0.25, z: 0 });
    });

    it("samples full circles with exactly the requested number of equal segments", () => {
        const first = { x: 1, y: 0, z: 0 };
        const second = { x: 0, y: 1, z: 0 };
        const third = { x: -1, y: 0, z: 0 };

        for (let steps = 3; steps <= 64; steps++) {
            const points = sampleArcThroughThreePoints(first, second, third, steps, false, true);
            expect(points).toHaveLength(steps + 1);
            expect(points[0]).toEqual(first);
            expect(points[steps]).toEqual(first);
            expect(points[0]).not.toBe(first);
            expect(points[steps]).not.toBe(points[0]);

            const segmentLength = 2 * Math.sin(Math.PI / steps);
            for (let index = 1; index < points.length; index++) {
                const dx = points[index]!.x - points[index - 1]!.x;
                const dy = points[index]!.y - points[index - 1]!.y;
                const dz = points[index]!.z - points[index - 1]!.z;
                expect(Math.hypot(dx, dy, dz)).toBeCloseTo(segmentLength, 10);
            }
        }
    });

    it("matches Babylon.js full-circle edge cases and partial-arc endpoint identity", () => {
        const first = { x: 1, y: 0, z: 0 };
        const second = { x: 0, y: 1, z: 0 };
        const third = { x: -1, y: 0, z: 0 };

        const zero = sampleArcThroughThreePoints(first, second, third, 0, false, true);
        expect(zero).toEqual([first]);
        expect(zero[0]).not.toBe(first);
        const fractional = sampleArcThroughThreePoints(first, second, third, 0.5, false, true);
        expect(fractional).toEqual([first, first]);
        expect(fractional[0]).not.toBe(first);
        expect(fractional[1]).not.toBe(first);
        expect(fractional[0]).not.toBe(fractional[1]);

        const partial = sampleArcThroughThreePoints(first, second, third, 8, true);
        expect(partial.at(-2)).toBe(third);
        expect(partial.at(-1)).toBe(first);
        expect(sampleArcThroughThreePoints(first, { x: 2, y: 0, z: 0 }, { x: 3, y: 0, z: 0 })).toEqual([]);
    });
});
