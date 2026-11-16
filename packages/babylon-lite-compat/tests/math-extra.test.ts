import { describe, expect, it } from "vitest";

import { Vector3 } from "../src/math/vector";
import { Matrix } from "../src/math/matrix";
import { Plane } from "../src/math/plane";
import { Ray } from "../src/math/ray";
import { Frustum } from "../src/math/frustum";
import { Size, Viewport } from "../src/math/size";
import { Angle, Curve3, Path3D } from "../src/math/curve";
import { GetWhiteBalanceMatrix, MaxTintMagnitude, MinTemperatureKelvin, TemperatureTintToXyz } from "../src/math/color-temperature";

describe("Plane", () => {
    it("builds from position and normal and measures signed distance", () => {
        const plane = Plane.FromPositionAndNormal(new Vector3(0, 0, 0), new Vector3(0, 1, 0));
        expect(plane.signedDistanceTo(new Vector3(0, 5, 0))).toBeCloseTo(5, 6);
        expect(plane.signedDistanceTo(new Vector3(0, -2, 0))).toBeCloseTo(-2, 6);
    });

    it("normalizes its normal", () => {
        const plane = new Plane(0, 4, 0, 8).normalize();
        expect(plane.normal.length()).toBeCloseTo(1, 6);
        expect(plane.d).toBeCloseTo(2, 6);
    });
});

describe("Ray", () => {
    it("intersects a plane in front of it", () => {
        const ray = new Ray(new Vector3(0, 5, 0), new Vector3(0, -1, 0));
        const plane = Plane.FromPositionAndNormal(new Vector3(0, 0, 0), new Vector3(0, 1, 0));
        expect(ray.intersectsPlane(plane)).toBeCloseTo(5, 6);
    });

    it("returns null for a plane behind it", () => {
        const ray = new Ray(new Vector3(0, 5, 0), new Vector3(0, 1, 0));
        const plane = Plane.FromPositionAndNormal(new Vector3(0, 0, 0), new Vector3(0, 1, 0));
        expect(ray.intersectsPlane(plane)).toBeNull();
    });

    it("detects sphere intersection", () => {
        const ray = new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, 1));
        expect(ray.intersectsSphere(new Vector3(0, 0, 10), 1)).toBe(true);
        expect(ray.intersectsSphere(new Vector3(5, 0, 10), 1)).toBe(false);
    });
});

describe("Frustum", () => {
    it("extracts six normalized planes from a matrix", () => {
        const planes = Frustum.GetPlanes(Matrix.Identity());
        expect(planes).toHaveLength(6);
        for (const plane of planes) {
            expect(plane.normal.length()).toBeCloseTo(1, 5);
        }
    });
});

describe("Size / Viewport", () => {
    it("computes surface and resolves a viewport to pixels", () => {
        expect(new Size(4, 3).surface).toBe(12);
        const px = new Viewport(0, 0, 0.5, 1).toGlobal(800, 600);
        expect(px.width).toBe(400);
        expect(px.height).toBe(600);
    });
});

describe("Curve / Path", () => {
    it("samples a quadratic bezier through its endpoints", () => {
        const curve = Curve3.CreateQuadraticBezier(new Vector3(0, 0, 0), new Vector3(1, 1, 0), new Vector3(2, 0, 0), 10);
        const pts = curve.getPoints();
        expect(pts[0]!.asArray()).toEqual([0, 0, 0]);
        expect(pts[pts.length - 1]!.x).toBeCloseTo(2, 6);
        expect(curve.length()).toBeGreaterThan(2);
    });

    describe("Color temperature", () => {
        it("converts temperature and tint to a normalized XYZ white point", () => {
            expect(MinTemperatureKelvin).toBe(1e6 / 600);
            expect(MaxTintMagnitude).toBe(150);
            expect(TemperatureTintToXyz(6500, 0).asArray()).toEqual([0.9690723182747721, 1, 1.1217921546755905]);
            expect(TemperatureTintToXyz(Number.NaN, 999).asArray()).toEqual(TemperatureTintToXyz(MinTemperatureKelvin, MaxTintMagnitude).asArray());
        });

        it("matches Babylon.js Bradford adaptation output", () => {
            expect(Array.from(GetWhiteBalanceMatrix(6500, 0))).toEqual([
                1.000000238418579, -3.65804595503505e-8, -3.1088023266789833e-9, 3.848475671475171e-8, 1.0000001192092896, -2.124672704439945e-8, 2.0227449937237907e-8,
                5.9020095477535506e-9, 0.9999998807907104,
            ]);
            expect(Array.from(GetWhiteBalanceMatrix(3200, 25))).toEqual([
                0.8247902393341064, 0.012983075343072414, 0.05875431001186371, -0.2952434718608856, 1.0849566459655762, 0.22875890135765076, -0.11453384906053543,
                -0.05379151552915573, 3.5795085430145264,
            ]);
        });
    });

    it("computes cumulative distances along a Path3D", () => {
        const path = new Path3D([new Vector3(0, 0, 0), new Vector3(0, 0, 3), new Vector3(0, 0, 7)]);
        expect(path.length()).toBeCloseTo(7, 6);
        expect(path.getDistances()).toEqual([0, 3, 7]);
    });

    it("converts angles", () => {
        expect(Angle.FromDegrees(180).radians()).toBeCloseTo(Math.PI, 6);
        expect(Angle.FromRadians(Math.PI).degrees()).toBeCloseTo(180, 6);
    });
});
