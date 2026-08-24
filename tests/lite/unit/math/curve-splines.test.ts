import { describe, expect, it } from "vitest";

import { sampleCatmullRomSpline, sampleHermiteSpline } from "../../../../packages/babylon-lite/src/math/curve-splines";

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
});
