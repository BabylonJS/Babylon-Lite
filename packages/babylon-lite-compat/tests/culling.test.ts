import { describe, expect, it } from "vitest";

import { Vector3 } from "../src/math/vector";
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
});

describe("BoundingSphere", () => {
    it("derives center and radius from min/max", () => {
        const sphere = new BoundingSphere(new Vector3(-1, 0, 0), new Vector3(1, 0, 0));
        expect(sphere.center.asArray()).toEqual([0, 0, 0]);
        expect(sphere.radius).toBeCloseTo(1, 6);
        expect(sphere.intersectsPoint(new Vector3(0.5, 0, 0))).toBe(true);
        expect(sphere.intersectsPoint(new Vector3(2, 0, 0))).toBe(false);
    });
});

describe("BoundingInfo", () => {
    it("exposes box and sphere and combined point test", () => {
        const info = new BoundingInfo(new Vector3(0, 0, 0), new Vector3(2, 2, 2));
        expect(info.minimum.asArray()).toEqual([0, 0, 0]);
        expect(info.maximum.asArray()).toEqual([2, 2, 2]);
        expect(info.intersectsPoint(info.boundingBox.center)).toBe(true);
    });
});
