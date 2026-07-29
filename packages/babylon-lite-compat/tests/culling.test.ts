import { describe, expect, it } from "vitest";

import { Vector3 } from "../src/math/vector";
import { Matrix } from "../src/math/matrix";
import { BoundingBox, BoundingSphere, BoundingInfo } from "../src/culling/bounding";

describe("BoundingBox", () => {
    it("computes center, extends, and 8 corners", () => {
        const box = new BoundingBox(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
        expect(box.center.asArray()).toEqual([0, 0, 0]);
        expect(box.extendSize.asArray()).toEqual([1, 1, 1]);
        expect(box.vectors).toHaveLength(8);
    });

    it("tests point containment", () => {
        const box = new BoundingBox(new Vector3(0, 0, 0), new Vector3(2, 2, 2));
        expect(box.intersectsPoint(new Vector3(1, 1, 1))).toBe(true);
        expect(box.intersectsPoint(new Vector3(3, 1, 1))).toBe(false);
    });

    it("detects box-box intersection", () => {
        const a = new BoundingBox(new Vector3(0, 0, 0), new Vector3(2, 2, 2));
        const b = new BoundingBox(new Vector3(1, 1, 1), new Vector3(3, 3, 3));
        const c = new BoundingBox(new Vector3(5, 5, 5), new Vector3(6, 6, 6));
        expect(BoundingBox.Intersects(a, b)).toBe(true);
        expect(BoundingBox.Intersects(a, c)).toBe(false);
    });

    it("mirrors local bounds into the world members when no world matrix is given", () => {
        const box = new BoundingBox(new Vector3(-1, -2, -3), new Vector3(4, 5, 6));
        expect(box.minimumWorld.asArray()).toEqual([-1, -2, -3]);
        expect(box.maximumWorld.asArray()).toEqual([4, 5, 6]);
        expect(box.centerWorld.asArray()).toEqual(box.center.asArray());
        expect(box.extendSizeWorld.asArray()).toEqual(box.extendSize.asArray());
        expect(box.vectorsWorld).toHaveLength(8);
        expect(box.vectorsWorld[0]!.asArray()).toEqual(box.vectors[0]!.asArray());
    });

    it("offsets the world AABB by a translation world matrix", () => {
        const box = new BoundingBox(new Vector3(-1, -1, -1), new Vector3(1, 1, 1), Matrix.Translation(1, 2, 3));
        // Local bounds are unchanged...
        expect(box.minimum.asArray()).toEqual([-1, -1, -1]);
        expect(box.maximum.asArray()).toEqual([1, 1, 1]);
        // ...world bounds are shifted by (1,2,3).
        expect(box.minimumWorld.asArray()).toEqual([0, 1, 2]);
        expect(box.maximumWorld.asArray()).toEqual([2, 3, 4]);
        expect(box.centerWorld.asArray()).toEqual([1, 2, 3]);
        expect(box.extendSizeWorld.asArray()).toEqual([1, 1, 1]);
    });

    it("fits the world AABB around all eight rotated corners (not just min/max)", () => {
        // 45° rotation about Z of a unit box: the AABB half-extent on X/Y grows to √2.
        const c = Math.cos(Math.PI / 4);
        const s = Math.sin(Math.PI / 4);
        const rot = Matrix.FromValues(c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
        const box = new BoundingBox(new Vector3(-1, -1, -1), new Vector3(1, 1, 1), rot);
        const sqrt2 = Math.SQRT2;
        expect(box.maximumWorld.x).toBeCloseTo(sqrt2, 6);
        expect(box.maximumWorld.y).toBeCloseTo(sqrt2, 6);
        expect(box.minimumWorld.x).toBeCloseTo(-sqrt2, 6);
        expect(box.minimumWorld.y).toBeCloseTo(-sqrt2, 6);
        expect(box.extendSizeWorld.x).toBeCloseTo(sqrt2, 6);
        expect(box.centerWorld.asArray().map((v) => Math.round(v))).toEqual([0, 0, 0]);
    });

    it("honours the world matrix passed to reConstruct", () => {
        const box = new BoundingBox(new Vector3(0, 0, 0), new Vector3(2, 2, 2));
        box.reConstruct(new Vector3(0, 0, 0), new Vector3(2, 2, 2), Matrix.Translation(10, 0, 0));
        expect(box.minimumWorld.asArray()).toEqual([10, 0, 0]);
        expect(box.maximumWorld.asArray()).toEqual([12, 2, 2]);
        expect(box.getWorldMatrix().m[12]).toBe(10);
    });
});

describe("BoundingSphere", () => {
    it("derives center and radius from min/max", () => {
        const sphere = new BoundingSphere(new Vector3(-1, 0, 0), new Vector3(1, 0, 0));
        expect(sphere.center.asArray()).toEqual([0, 0, 0]);
        expect(sphere.radius).toBeCloseTo(1, 6);
        expect(sphere.intersectsPoint(new Vector3(0.5, 0, 0))).toBe(true);
        expect(sphere.intersectsPoint(new Vector3(2, 0, 0))).toBe(false);
    });

    it("derives world center and radius from the world matrix", () => {
        // Translate by (5,0,0) and uniformly scale by 2.
        const world = Matrix.FromValues(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 0, 0, 1);
        const sphere = new BoundingSphere(new Vector3(-1, 0, 0), new Vector3(1, 0, 0), world);
        expect(sphere.centerWorld.asArray()).toEqual([5, 0, 0]);
        expect(sphere.radiusWorld).toBeCloseTo(2, 6);
    });
});

describe("BoundingInfo", () => {
    it("exposes box and sphere and combined point test", () => {
        const info = new BoundingInfo(new Vector3(0, 0, 0), new Vector3(2, 2, 2));
        expect(info.minimum.asArray()).toEqual([0, 0, 0]);
        expect(info.maximum.asArray()).toEqual([2, 2, 2]);
        expect(info.intersectsPoint(info.boundingBox.center)).toBe(true);
    });

    it("threads the world matrix into both the box and sphere", () => {
        const info = new BoundingInfo(new Vector3(-1, -1, -1), new Vector3(1, 1, 1), Matrix.Translation(1, 2, 3));
        expect(info.boundingBox.minimumWorld.asArray()).toEqual([0, 1, 2]);
        expect(info.boundingBox.maximumWorld.asArray()).toEqual([2, 3, 4]);
        expect(info.boundingSphere.centerWorld.asArray()).toEqual([1, 2, 3]);
    });

    it("re-derives world bounds via update() and reConstruct()", () => {
        const info = new BoundingInfo(new Vector3(0, 0, 0), new Vector3(2, 2, 2));
        info.update(Matrix.Translation(1, 0, 0));
        expect(info.boundingBox.minimumWorld.asArray()).toEqual([1, 0, 0]);
        info.reConstruct(new Vector3(0, 0, 0), new Vector3(4, 4, 4), Matrix.Translation(0, 5, 0));
        expect(info.maximum.asArray()).toEqual([4, 4, 4]);
        expect(info.boundingBox.maximumWorld.asArray()).toEqual([4, 9, 4]);
    });
});
