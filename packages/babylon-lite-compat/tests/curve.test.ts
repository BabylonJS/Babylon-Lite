import { describe, expect, it } from "vitest";

import { Vector3 } from "../src/math/vector";
import { Quaternion } from "../src/math/quaternion";
import { Matrix } from "../src/math/matrix";
import { Curve3, Path3D } from "../src/math/curve";

describe("Vector3.Hermite / CatmullRom", () => {
    it("Hermite returns the endpoints at t=0 and t=1", () => {
        const p1 = new Vector3(0, 0, 0);
        const p2 = new Vector3(1, 2, 3);
        const t1 = new Vector3(1, 0, 0);
        const t2 = new Vector3(0, 1, 0);
        const a = Vector3.Hermite(p1, t1, p2, t2, 0);
        const b = Vector3.Hermite(p1, t1, p2, t2, 1);
        expect([a.x, a.y, a.z]).toEqual([0, 0, 0]);
        expect([b.x, b.y, b.z]).toEqual([1, 2, 3]);
    });

    it("CatmullRom passes through the inner control points at t=0 and t=1", () => {
        const v1 = new Vector3(0, 0, 0);
        const v2 = new Vector3(1, 0, 0);
        const v3 = new Vector3(2, 1, 0);
        const v4 = new Vector3(3, 0, 0);
        const at0 = Vector3.CatmullRom(v1, v2, v3, v4, 0);
        const at1 = Vector3.CatmullRom(v1, v2, v3, v4, 1);
        expect(at0.x).toBeCloseTo(1, 6);
        expect(at0.y).toBeCloseTo(0, 6);
        expect(at1.x).toBeCloseTo(2, 6);
        expect(at1.y).toBeCloseTo(1, 6);
    });
});

describe("Curve3 spline factories", () => {
    it("CreateHermiteSpline produces nSeg+1 points hitting both endpoints", () => {
        const curve = Curve3.CreateHermiteSpline(new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(1, 1, 0), new Vector3(0, 1, 0), 10);
        const pts = curve.getPoints();
        expect(pts.length).toBe(11);
        expect([pts[0]!.x, pts[0]!.y]).toEqual([0, 0]);
        expect([pts[10]!.x, pts[10]!.y]).toEqual([1, 1]);
    });

    it("CreateCatmullRomSpline (open) spans the control points", () => {
        const points = [new Vector3(0, 0, 0), new Vector3(1, 1, 0), new Vector3(2, 0, 0), new Vector3(3, 1, 0)];
        const curve = Curve3.CreateCatmullRomSpline(points, 5);
        const pts = curve.getPoints();
        // 4 control points → 6 padded points → 3 segments * nbPoints + 1 closing point.
        expect(pts.length).toBe(3 * 5 + 1);
        expect([pts[0]!.x, pts[0]!.y]).toEqual([0, 0]);
        const last = pts[pts.length - 1]!;
        expect(last.x).toBeCloseTo(3, 6);
        expect(last.y).toBeCloseTo(1, 6);
    });

    it("CreateCatmullRomSpline (closed) loops back to the start", () => {
        const points = [new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(1, 1, 0), new Vector3(0, 1, 0)];
        const curve = Curve3.CreateCatmullRomSpline(points, 4, true);
        const pts = curve.getPoints();
        expect(pts.length).toBe(points.length * 4 + 1);
        const first = pts[0]!;
        const last = pts[pts.length - 1]!;
        expect(last.x).toBeCloseTo(first.x, 6);
        expect(last.y).toBeCloseTo(first.y, 6);
        expect(last.z).toBeCloseTo(first.z, 6);
    });
});

describe("Path3D", () => {
    const straight = () => new Path3D([new Vector3(0, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 0, 2), new Vector3(0, 0, 3)]);

    it("computes cumulative distances and total length", () => {
        const path = straight();
        expect(path.getDistances()).toEqual([0, 1, 2, 3]);
        expect(path.length()).toBe(3);
        expect(path.getDistanceAt(0.5)).toBeCloseTo(1.5, 6);
    });

    it("produces normalized orthonormal Frenet frames", () => {
        const path = straight();
        const tangents = path.getTangents();
        const normals = path.getNormals();
        const binormals = path.getBinormals();
        expect(tangents.length).toBe(4);
        for (let i = 0; i < 4; i++) {
            expect(tangents[i]!.length()).toBeCloseTo(1, 6);
            expect(normals[i]!.length()).toBeCloseTo(1, 6);
            expect(binormals[i]!.length()).toBeCloseTo(1, 6);
            expect(Vector3.Dot(tangents[i]!, normals[i]!)).toBeCloseTo(0, 6);
            expect(Vector3.Dot(tangents[i]!, binormals[i]!)).toBeCloseTo(0, 6);
        }
        // Tangent of a +Z line is +Z.
        expect(tangents[0]!.z).toBeCloseTo(1, 6);
    });

    it("interpolates points along the path", () => {
        const path = straight();
        const mid = path.getPointAt(0.5);
        expect(mid.z).toBeCloseTo(1.5, 6);
        expect(path.getPreviousPointIndexAt(0.5)).toBe(1);
        const start = path.getPointAt(0);
        const end = path.getPointAt(1);
        expect(start.z).toBeCloseTo(0, 6);
        expect(end.z).toBeCloseTo(3, 6);
    });

    it("returns a tangent at an interpolated position (interpolated frame)", () => {
        const path = straight();
        const tangent = path.getTangentAt(0.5, true);
        expect(tangent.length()).toBeCloseTo(1, 6);
        expect(tangent.z).toBeCloseTo(1, 6);
    });

    it("finds the closest position to an arbitrary point", () => {
        const path = straight();
        const pos = path.getClosestPositionTo(new Vector3(0.5, 0, 1.5));
        expect(pos).toBeCloseTo(0.5, 4);
    });

    it("slices a sub-path", () => {
        const path = straight();
        const sub = path.slice(0.25, 0.75);
        const pts = sub.getCurve();
        expect(pts[0]!.z).toBeCloseTo(0.75, 6);
        expect(pts[pts.length - 1]!.z).toBeCloseTo(2.25, 6);
    });

    it("update recomputes the frame from new points", () => {
        const path = straight();
        path.update([new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(2, 0, 0), new Vector3(3, 0, 0)]);
        expect(path.length()).toBeCloseTo(3, 6);
        expect(path.getTangents()[0]!.x).toBeCloseTo(1, 6);
    });
});

describe("Quaternion axis/matrix helpers", () => {
    it("RotationQuaternionFromAxis builds an identity quaternion from the standard basis", () => {
        const q = Quaternion.RotationQuaternionFromAxis(new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1));
        expect(q.x).toBeCloseTo(0, 6);
        expect(q.y).toBeCloseTo(0, 6);
        expect(q.z).toBeCloseTo(0, 6);
        expect(Math.abs(q.w)).toBeCloseTo(1, 6);
    });

    it("toRotationMatrix round-trips the identity quaternion", () => {
        const m = Quaternion.Identity().toRotationMatrix(Matrix.Identity());
        const id = Matrix.Identity();
        for (let i = 0; i < 16; i++) {
            expect(m.m[i]!).toBeCloseTo(id.m[i]!, 6);
        }
    });
});
