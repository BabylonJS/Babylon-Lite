import { describe, expect, it } from "vitest";

import { Vector2, Vector3 } from "../src/math/vector";
import { Quaternion } from "../src/math/quaternion";
import { Matrix } from "../src/math/matrix";
import { Angle, Curve3, Path3D } from "../src/math/curve";

describe("Vector3 spline helpers", () => {
    it("Hermite passes through its endpoints", () => {
        const p1 = new Vector3(0, 0, 0);
        const p2 = new Vector3(1, 0, 0);
        const t1 = new Vector3(0, 1, 0);
        const t2 = new Vector3(0, 1, 0);
        expect(Vector3.Hermite(p1, t1, p2, t2, 0).asArray()).toEqual([0, 0, 0]);
        const end = Vector3.Hermite(p1, t1, p2, t2, 1);
        expect(end.x).toBeCloseTo(1, 6);
        expect(end.y).toBeCloseTo(0, 6);
    });

    it("CatmullRom passes through the inner control points", () => {
        const a = new Vector3(0, 0, 0);
        const b = new Vector3(1, 1, 0);
        const c = new Vector3(2, 0, 0);
        const d = new Vector3(3, 1, 0);
        expect(Vector3.CatmullRom(a, b, c, d, 0).asArray()).toEqual([1, 1, 0]);
        expect(Vector3.CatmullRom(a, b, c, d, 1).asArray()).toEqual([2, 0, 0]);
    });
});

describe("Quaternion axis/matrix helpers", () => {
    it("RotationQuaternionFromAxis on identity axes yields identity", () => {
        const q = Quaternion.RotationQuaternionFromAxis(new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1));
        expect(q.x).toBeCloseTo(0, 6);
        expect(q.y).toBeCloseTo(0, 6);
        expect(q.z).toBeCloseTo(0, 6);
        expect(Math.abs(q.w)).toBeCloseTo(1, 6);
    });

    it("toRotationMatrix round-trips through FromRotationMatrix", () => {
        const q = Quaternion.RotationYawPitchRoll(0.4, -0.3, 0.6).normalize();
        const m = Matrix.Identity();
        q.toRotationMatrix(m);
        const back = Quaternion.FromRotationMatrix(m);
        // Quaternions q and -q represent the same rotation; compare with sign alignment.
        const sign = q.w * back.w < 0 ? -1 : 1;
        expect(back.x * sign).toBeCloseTo(q.x, 5);
        expect(back.y * sign).toBeCloseTo(q.y, 5);
        expect(back.z * sign).toBeCloseTo(q.z, 5);
        expect(back.w * sign).toBeCloseTo(q.w, 5);
    });

    it("toRotationMatrix of identity is the identity matrix", () => {
        const m = Matrix.Identity();
        Quaternion.Identity().toRotationMatrix(m);
        expect(Array.from(m.m)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    });
});

describe("Curve3 builders", () => {
    it("Hermite spline starts and ends at its control points", () => {
        const curve = Curve3.CreateHermiteSpline(new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(4, 0, 0), new Vector3(1, 0, 0), 20);
        const pts = curve.getPoints();
        expect(pts.length).toBe(21);
        expect(pts[0]!.asArray()).toEqual([0, 0, 0]);
        expect(pts[pts.length - 1]!.x).toBeCloseTo(4, 6);
    });

    it("open Catmull-Rom spline interpolates the given points", () => {
        const points = [new Vector3(0, 0, 0), new Vector3(1, 2, 0), new Vector3(3, 2, 0), new Vector3(4, 0, 0)];
        const curve = Curve3.CreateCatmullRomSpline(points, 8, false);
        const pts = curve.getPoints();
        expect(pts[0]!.asArray()).toEqual([0, 0, 0]);
        expect(pts[pts.length - 1]!.x).toBeCloseTo(4, 6);
    });

    it("closed Catmull-Rom spline loops back to its first sample", () => {
        const points = [new Vector3(0, 0, 0), new Vector3(2, 0, 0), new Vector3(2, 2, 0), new Vector3(0, 2, 0)];
        const curve = Curve3.CreateCatmullRomSpline(points, 6, true);
        const pts = curve.getPoints();
        expect(pts[0]!.equalsWithEpsilon(pts[pts.length - 1]!, 1e-6)).toBe(true);
    });

    it("ArcThru3Points returns an empty curve for colinear points", () => {
        const arc = Curve3.ArcThru3Points(new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(2, 0, 0));
        expect(arc.getPoints().length).toBe(0);
    });

    it("ArcThru3Points passes through the three points", () => {
        const first = new Vector3(1, 0, 0);
        const second = new Vector3(0, 1, 0);
        const third = new Vector3(-1, 0, 0);
        const arc = Curve3.ArcThru3Points(first, second, third, 36);
        const pts = arc.getPoints();
        expect(pts.length).toBeGreaterThan(2);
        expect(pts[0]!.equalsWithEpsilon(first, 1e-6)).toBe(true);
        expect(pts[pts.length - 1]!.equalsWithEpsilon(third, 1e-6)).toBe(true);
        // every arc point is on the unit circle (radius 1)
        for (const p of pts) {
            expect(p.length()).toBeCloseTo(1, 4);
        }
    });

    it("continue translates the second curve onto the first's end", () => {
        const a = new Curve3([new Vector3(0, 0, 0), new Vector3(1, 0, 0)]);
        const b = new Curve3([new Vector3(5, 5, 5), new Vector3(6, 5, 5)]);
        const joined = a.continue(b);
        const pts = joined.getPoints();
        expect(pts.length).toBe(3);
        // b's first point (5,5,5) is dropped; its second point is translated so the join is seamless
        expect(pts[2]!.asArray()).toEqual([2, 0, 0]);
    });
});

describe("Path3D frames and interpolation", () => {
    const square = [new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(1, 1, 0), new Vector3(0, 1, 0)];

    it("computes an orthonormal tangent/normal/binormal frame per point", () => {
        const path = new Path3D(square);
        const tangents = path.getTangents();
        const normals = path.getNormals();
        const binormals = path.getBinormals();
        expect(tangents.length).toBe(square.length);
        for (let i = 0; i < square.length; i++) {
            expect(tangents[i]!.length()).toBeCloseTo(1, 5);
            expect(normals[i]!.length()).toBeCloseTo(1, 5);
            expect(binormals[i]!.length()).toBeCloseTo(1, 5);
            expect(Vector3.Dot(tangents[i]!, normals[i]!)).toBeCloseTo(0, 5);
            expect(Vector3.Dot(tangents[i]!, binormals[i]!)).toBeCloseTo(0, 5);
        }
    });

    it("getPointAt walks the arc-length parameterisation", () => {
        const path = new Path3D([new Vector3(0, 0, 0), new Vector3(0, 0, 4)]);
        expect(path.getPointAt(0).asArray()).toEqual([0, 0, 0]);
        expect(path.getPointAt(0.5).z).toBeCloseTo(2, 6);
        expect(path.getPointAt(1).z).toBeCloseTo(4, 6);
        expect(path.getDistanceAt(0.25)).toBeCloseTo(1, 6);
    });

    it("getSubPositionAt and getPreviousPointIndexAt locate the segment", () => {
        const path = new Path3D([new Vector3(0, 0, 0), new Vector3(0, 0, 2), new Vector3(0, 0, 4)]);
        expect(path.getPreviousPointIndexAt(0.25)).toBe(0);
        expect(path.getSubPositionAt(0.25)).toBeCloseTo(0.5, 6);
        expect(path.getPreviousPointIndexAt(0.75)).toBe(1);
    });

    it("getTangentAt interpolated returns a unit tangent", () => {
        const path = new Path3D(square);
        const t = path.getTangentAt(0.4, true);
        expect(t.length()).toBeCloseTo(1, 5);
    });

    it("getClosestPositionTo finds the nearest position on the path", () => {
        const path = new Path3D([new Vector3(0, 0, 0), new Vector3(4, 0, 0)]);
        const pos = path.getClosestPositionTo(new Vector3(1, 1, 0));
        expect(pos).toBeCloseTo(0.25, 5);
    });

    it("slice extracts a sub-path", () => {
        const path = new Path3D([new Vector3(0, 0, 0), new Vector3(0, 0, 2), new Vector3(0, 0, 4)]);
        const sub = path.slice(0.25, 0.75);
        expect(sub.getPointAt(0).z).toBeCloseTo(1, 5);
        expect(sub.getPointAt(1).z).toBeCloseTo(3, 5);
    });

    it("update recomputes distances in place", () => {
        const path = new Path3D([new Vector3(0, 0, 0), new Vector3(0, 0, 1)]);
        expect(path.length()).toBeCloseTo(1, 6);
        path.update([new Vector3(0, 0, 0), new Vector3(0, 0, 5)]);
        expect(path.length()).toBeCloseTo(5, 6);
    });
});

describe("Angle", () => {
    it("normalises negative angles into [0, 2π)", () => {
        expect(new Angle(-Math.PI / 2).radians()).toBeCloseTo((3 * Math.PI) / 2, 6);
    });

    it("BetweenTwoPoints measures against the x-axis", () => {
        expect(Angle.BetweenTwoPoints(new Vector2(0, 0), new Vector2(1, 1)).radians()).toBeCloseTo(Math.PI / 4, 6);
    });

    it("BetweenTwoVectors returns the unsigned angle", () => {
        expect(Angle.BetweenTwoVectors(new Vector3(1, 0, 0), new Vector3(0, 1, 0)).radians()).toBeCloseTo(Math.PI / 2, 6);
        expect(Angle.BetweenTwoVectors(new Vector2(1, 0), new Vector2(1, 0)).radians()).toBeCloseTo(0, 6);
    });
});
