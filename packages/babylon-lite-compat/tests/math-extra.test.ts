import { describe, expect, it } from "vitest";

import { Vector3 } from "../src/math/vector";
import { Matrix } from "../src/math/matrix";
import { Plane } from "../src/math/plane";
import { Ray } from "../src/math/ray";
import { Frustum } from "../src/math/frustum";
import { Size, Viewport } from "../src/math/size";
import { Angle, Curve3, Path3D } from "../src/math/curve";

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
