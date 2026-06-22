import { describe, expect, it } from "vitest";

import {
    addVec3InPlace,
    addVec3ToRef,
    crossVec3InPlace,
    crossVec3ToRef,
    lerpVec3InPlace,
    lerpVec3ToRef,
    negateVec3InPlace,
    negateVec3ToRef,
    normalizeVec3InPlace,
    normalizeVec3ToRef,
    scaleVec3InPlace,
    scaleVec3ToRef,
    subVec3InPlace,
    subVec3ToRef,
} from "../../../packages/babylon-lite/src/math/vec3-ref";

describe("Vec3 ref helpers", () => {
    it("writes ToRef results into the provided output object", () => {
        const out = { x: 0, y: 0, z: 0 };

        expect(addVec3ToRef({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, out)).toBe(out);
        expect(out).toEqual({ x: 5, y: 7, z: 9 });

        subVec3ToRef({ x: 7, y: 8, z: 9 }, { x: 1, y: 2, z: 3 }, out);
        expect(out).toEqual({ x: 6, y: 6, z: 6 });

        scaleVec3ToRef({ x: 1, y: -2, z: 3 }, 3, out);
        expect(out).toEqual({ x: 3, y: -6, z: 9 });

        crossVec3ToRef({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, out);
        expect(out).toEqual({ x: 0, y: 0, z: 1 });

        normalizeVec3ToRef({ x: 0, y: 3, z: 4 }, out);
        expect(out.x).toBeCloseTo(0);
        expect(out.y).toBeCloseTo(0.6);
        expect(out.z).toBeCloseTo(0.8);

        negateVec3ToRef({ x: 1, y: -2, z: 3 }, out);
        expect(out).toEqual({ x: -1, y: 2, z: -3 });

        lerpVec3ToRef({ x: 0, y: 0, z: 0 }, { x: 2, y: 4, z: 6 }, 0.25, out);
        expect(out).toEqual({ x: 0.5, y: 1, z: 1.5 });
    });

    it("mutates the target object for InPlace variants", () => {
        const target = { x: 1, y: 2, z: 3 };

        expect(addVec3InPlace(target, { x: 1, y: 1, z: 1 })).toBe(target);
        expect(target).toEqual({ x: 2, y: 3, z: 4 });

        subVec3InPlace(target, { x: 1, y: 2, z: 3 });
        expect(target).toEqual({ x: 1, y: 1, z: 1 });

        scaleVec3InPlace(target, 2);
        expect(target).toEqual({ x: 2, y: 2, z: 2 });

        crossVec3InPlace(target, { x: 0, y: 1, z: 0 });
        expect(target).toEqual({ x: -2, y: 0, z: 2 });

        normalizeVec3InPlace(target);
        expect(target.x).toBeCloseTo(-Math.SQRT1_2);
        expect(target.y).toBeCloseTo(0);
        expect(target.z).toBeCloseTo(Math.SQRT1_2);

        negateVec3InPlace(target);
        expect(target.x).toBeCloseTo(Math.SQRT1_2);
        expect(target.y).toBeCloseTo(0);
        expect(target.z).toBeCloseTo(-Math.SQRT1_2);

        lerpVec3InPlace(target, { x: 0, y: 0, z: 0 }, 1);
        expect(target).toEqual({ x: 0, y: 0, z: 0 });
    });
});
