import { describe, expect, it } from "vitest";

import { Vector2, Vector3, Vector4 } from "../src/math/vector";
import { liteBackedVector3 } from "../src/math/vector";
import { Color3, Color4 } from "../src/math/color";
import { Quaternion } from "../src/math/quaternion";
import { Matrix } from "../src/math/matrix";
import { Scalar } from "../src/math/scalar";
import { Axis, Space } from "../src/math/constants";

describe("Vector3", () => {
    it("adds, subtracts, and scales", () => {
        const a = new Vector3(1, 2, 3);
        const b = new Vector3(4, 5, 6);
        expect(a.add(b).asArray()).toEqual([5, 7, 9]);
        expect(b.subtract(a).asArray()).toEqual([3, 3, 3]);
        expect(a.scale(2).asArray()).toEqual([2, 4, 6]);
    });

    it("mutates in place", () => {
        const a = new Vector3(1, 1, 1);
        a.addInPlace(new Vector3(1, 2, 3));
        expect(a.asArray()).toEqual([2, 3, 4]);
        a.x += 1;
        expect(a.x).toBe(3);
    });

    it("computes length, dot, and cross", () => {
        expect(new Vector3(3, 4, 0).length()).toBe(5);
        expect(Vector3.Dot(new Vector3(1, 0, 0), new Vector3(0, 1, 0))).toBe(0);
        expect(Vector3.Cross(new Vector3(1, 0, 0), new Vector3(0, 1, 0)).asArray()).toEqual([0, 0, 1]);
    });

    it("normalizes", () => {
        const v = new Vector3(0, 0, 5).normalize();
        expect(v.asArray()).toEqual([0, 0, 1]);
    });

    it("provides direction constants", () => {
        expect(Vector3.Up().asArray()).toEqual([0, 1, 0]);
        expect(Vector3.Forward().asArray()).toEqual([0, 0, 1]);
    });

    it("writes common static helper results into refs", () => {
        const ref = Vector3.Zero();
        expect(Vector3.FromArrayToRef([9, 8, 7, 6], 1, ref)).toBe(ref);
        expect(ref.asArray()).toEqual([8, 7, 6]);
        expect(Vector3.FromFloatsToRef(1, 2, 3, ref)).toBe(ref);
        expect(ref.asArray()).toEqual([1, 2, 3]);

        const a = new Vector3(1, 2, 3);
        const b = new Vector3(4, 6, 8);
        expect(Vector3.LerpToRef(a, b, 0.5, ref)).toBe(ref);
        expect(ref.asArray()).toEqual([2.5, 4, 5.5]);
        expect(a.asArray()).toEqual([1, 2, 3]);
        expect(b.asArray()).toEqual([4, 6, 8]);

        expect(Vector3.Minimize(a, b).asArray()).toEqual([1, 2, 3]);
        expect(Vector3.Maximize(a, b).asArray()).toEqual([4, 6, 8]);
        expect(a.asArray()).toEqual([1, 2, 3]);
        expect(b.asArray()).toEqual([4, 6, 8]);
    });

    it("minimizes and maximizes in place", () => {
        const a = new Vector3(1, 5, 3);
        expect(a.minimizeInPlace(new Vector3(4, 2, 3))).toBe(a);
        expect(a.asArray()).toEqual([1, 2, 3]);
        expect(a.maximizeInPlace(new Vector3(0, 6, 3))).toBe(a);
        expect(a.asArray()).toEqual([1, 6, 3]);

        expect(a.minimizeInPlaceFromFloats(0, 7, 2)).toBe(a);
        expect(a.asArray()).toEqual([0, 6, 2]);
        expect(a.maximizeInPlaceFromFloats(5, 1, 9)).toBe(a);
        expect(a.asArray()).toEqual([5, 6, 9]);
    });

    it("writes cross, normalize, and transform helper results into refs", () => {
        const ref = Vector3.Zero();
        expect(Vector3.CrossToRef(new Vector3(1, 0, 0), new Vector3(0, 1, 0), ref)).toBe(ref);
        expect(ref.asArray()).toEqual([0, 0, 1]);

        expect(Vector3.NormalizeToRef(new Vector3(0, 0, 5), ref)).toBe(ref);
        expect(ref.asArray()).toEqual([0, 0, 1]);
        expect(Vector3.NormalizeToRef(Vector3.Zero(), ref)).toBe(ref);
        expect(ref.asArray()).toEqual([0, 0, 0]);

        const translation = Matrix.Translation(1, 2, 3);
        expect(Vector3.TransformCoordinatesToRef(Vector3.Zero(), translation, ref)).toBe(ref);
        expect(ref.asArray()).toEqual([1, 2, 3]);
        expect(Vector3.TransformNormalToRef(new Vector3(1, 0, 0), translation, ref)).toBe(ref);
        expect(ref.asArray()).toEqual([1, 0, 0]);
    });
});

describe("liteBackedVector3 (write-through transform proxy)", () => {
    it("reads and writes through to the backing Lite vector and supports in-place methods", () => {
        const lite = { x: 1, y: 2, z: 3 };
        const v = liteBackedVector3(lite);
        // reads pass through
        expect(v.asArray()).toEqual([1, 2, 3]);
        // direct component write passes through
        v.x = 10;
        expect(lite.x).toBe(10);
        // inherited in-place methods mutate the backing vector (scene 125's scaleInPlace)
        v.scaleInPlace(2);
        expect(lite).toEqual({ x: 20, y: 4, z: 6 });
        v.set(0, 0, 0);
        expect(lite).toEqual({ x: 0, y: 0, z: 0 });
    });

    it("returns a stable proxy per backing vector (Babylon.js identity parity)", () => {
        const lite = { x: 0, y: 0, z: 0 };
        expect(liteBackedVector3(lite)).toBe(liteBackedVector3(lite));
    });
});

describe("Vector2 / Vector4", () => {
    it("supports basic ops", () => {
        expect(new Vector2(3, 4).length()).toBe(5);
        expect(new Vector4(1, 2, 3, 4).asArray()).toEqual([1, 2, 3, 4]);
    });
});

describe("Color3 / Color4", () => {
    it("round-trips hex strings", () => {
        const red = Color3.FromHexString("#ff0000");
        expect(red.r).toBeCloseTo(1);
        expect(red.g).toBe(0);
        expect(red.toHexString()).toBe("#FF0000");
    });

    it("converts Color3 to Color4", () => {
        const c4 = new Color3(0.1, 0.2, 0.3).toColor4(0.5);
        expect(c4.asArray()).toEqual([0.1, 0.2, 0.3, 0.5]);
    });

    it("exposes named colours", () => {
        expect(Color3.White().asArray()).toEqual([1, 1, 1]);
        expect(new Color4(1, 0, 0, 1).equals(new Color4(1, 0, 0, 1))).toBe(true);
    });
});

describe("Matrix", () => {
    it("starts as identity and multiplies with identity as a no-op", () => {
        const id = Matrix.Identity();
        const t = Matrix.Translation(1, 2, 3);
        expect(id.multiply(t).equals(t)).toBe(true);
        expect(t.multiply(id).equals(t)).toBe(true);
    });

    it("transforms coordinates with translation", () => {
        const t = Matrix.Translation(1, 2, 3);
        const p = Vector3.TransformCoordinates(new Vector3(0, 0, 0), t);
        expect(p.asArray()).toEqual([1, 2, 3]);
    });

    it("rotates a coordinate about Z by 90 degrees", () => {
        const r = Matrix.RotationZ(Math.PI / 2);
        const p = Vector3.TransformCoordinates(new Vector3(1, 0, 0), r);
        expect(p.x).toBeCloseTo(0, 6);
        expect(p.y).toBeCloseTo(1, 6);
    });

    it("composes scale, rotation, and translation", () => {
        const m = Matrix.Scaling(2, 1, 1)
            .multiply(Matrix.RotationZ(Math.PI / 2))
            .multiply(Matrix.Translation(10, 0, 0));
        const p = Vector3.TransformCoordinates(new Vector3(1, 0, 0), m);
        expect(p.x).toBeCloseTo(10, 6);
        expect(p.y).toBeCloseTo(2, 6);
    });

    it("inverts a transform back to the identity", () => {
        const m = Matrix.Translation(3, -2, 5).multiply(Matrix.RotationY(0.7));
        const round = m.multiply(m.invert());
        expect(round.equals(Matrix.Identity())).toBe(false); // float drift expected
        for (let i = 0; i < 16; i++) {
            const expected = i % 5 === 0 ? 1 : 0;
            expect(round.m[i]).toBeCloseTo(expected, 5);
        }
    });

    it("transforms a normal ignoring translation", () => {
        const m = Matrix.Translation(100, 100, 100);
        const n = Vector3.TransformNormal(new Vector3(1, 0, 0), m);
        expect(n.asArray()).toEqual([1, 0, 0]);
    });
});

describe("Quaternion", () => {
    it("has an identity", () => {
        expect(Quaternion.Identity().asArray()).toEqual([0, 0, 0, 1]);
    });

    it("builds from Euler angles and round-trips back", () => {
        const q = Quaternion.FromEulerAngles(0.3, -0.4, 0.5);
        const e = q.toEulerAngles();
        expect(e.x).toBeCloseTo(0.3, 5);
        expect(e.y).toBeCloseTo(-0.4, 5);
        expect(e.z).toBeCloseTo(0.5, 5);
    });

    it("stays normalized after composition", () => {
        const q = Quaternion.RotationYawPitchRoll(0.5, 0.5, 0.5).multiply(Quaternion.RotationYawPitchRoll(-0.2, 0.1, 0.3));
        expect(q.length()).toBeGreaterThan(0);
        q.normalize();
        expect(q.length()).toBeCloseTo(1, 6);
    });
});

describe("Scalar / constants", () => {
    it("clamps and lerps", () => {
        expect(Scalar.Clamp(5, 0, 1)).toBe(1);
        expect(Scalar.Lerp(0, 10, 0.5)).toBe(5);
        expect(Scalar.DegreesToRadians(180)).toBeCloseTo(Math.PI, 6);
    });

    it("exposes axes and spaces", () => {
        expect(Axis.X.asArray()).toEqual([1, 0, 0]);
        expect(Space.WORLD).toBe(1);
        expect(Space.LOCAL).toBe(0);
    });
});
