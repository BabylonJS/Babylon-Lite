import { beforeEach, describe, expect, it, vi } from "vitest";

const { sampleArcThroughThreePointsMock, sampleCatmullRomSplineMock, sampleHermiteSplineMock } = vi.hoisted(() => ({
    sampleArcThroughThreePointsMock: vi.fn(),
    sampleCatmullRomSplineMock: vi.fn(),
    sampleHermiteSplineMock: vi.fn(),
}));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        sampleArcThroughThreePoints: sampleArcThroughThreePointsMock,
        sampleCatmullRomSpline: sampleCatmullRomSplineMock,
        sampleHermiteSpline: sampleHermiteSplineMock,
    };
});

import { Curve3 } from "../src/math/curve";
import { Vector3 } from "../src/math/vector";

describe("Curve3 splines", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("forwards Hermite arguments to Lite and wraps the sampled points", () => {
        const p1 = new Vector3(0, 1, 2);
        const t1 = new Vector3(3, 4, 5);
        const p2 = new Vector3(6, 7, 8);
        const t2 = new Vector3(9, 10, 11);
        sampleHermiteSplineMock.mockReturnValue([
            { x: 0, y: 1, z: 2 },
            { x: 6, y: 7, z: 8 },
        ]);

        const points = Curve3.CreateHermiteSpline(p1, t1, p2, t2, 12).getPoints();

        expect(sampleHermiteSplineMock).toHaveBeenCalledWith(p1, t1, p2, t2, 12);
        expect(points.map((point) => point.asArray())).toEqual([
            [0, 1, 2],
            [6, 7, 8],
        ]);
        expect(points[0]).toBeInstanceOf(Vector3);
    });

    it("forwards Catmull-Rom arguments with Babylon.js's false default", () => {
        const controls = [new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(2, 1, 0), new Vector3(3, 1, 0)];
        sampleCatmullRomSplineMock.mockReturnValue([{ x: 1, y: 0, z: 0 }]);

        const points = Curve3.CreateCatmullRomSpline(controls, 8).getPoints();

        expect(sampleCatmullRomSplineMock).toHaveBeenCalledWith(controls, 8, false);
        expect(points[0]!.asArray()).toEqual([1, 0, 0]);
    });

    it("forwards the closed Catmull-Rom option", () => {
        const controls = [new Vector3(), new Vector3(1), new Vector3(2), new Vector3(3)];
        sampleCatmullRomSplineMock.mockReturnValue([]);

        Curve3.CreateCatmullRomSpline(controls, 4, true);

        expect(sampleCatmullRomSplineMock).toHaveBeenCalledWith(controls, 4, true);
    });

    it("forwards ArcThru3Points arguments with Babylon.js defaults and wraps Lite points", () => {
        const first = new Vector3(1, 0, 0);
        const second = new Vector3(0, 1, 0);
        const third = new Vector3(-1, 0, 0);
        sampleArcThroughThreePointsMock.mockReturnValue([{ x: 1, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }, third]);

        const points = Curve3.ArcThru3Points(first, second, third).getPoints();

        expect(sampleArcThroughThreePointsMock).toHaveBeenCalledWith(first, second, third, 32, false, false);
        expect(points[0]).toEqual(first);
        expect(points[0]).not.toBe(first);
        expect(points[1]).toEqual(new Vector3(0, -1, 0));
        expect(points[1]).toBeInstanceOf(Vector3);
        expect(points[2]).toBe(third);
    });

    it("forwards ArcThru3Points options", () => {
        const first = new Vector3(1, 0, 0);
        const second = new Vector3(0, 1, 0);
        const third = new Vector3(-1, 0, 0);
        sampleArcThroughThreePointsMock.mockReturnValue([]);

        Curve3.ArcThru3Points(first, second, third, 12, true, true);

        expect(sampleArcThroughThreePointsMock).toHaveBeenCalledWith(first, second, third, 12, true, true);
    });
});
