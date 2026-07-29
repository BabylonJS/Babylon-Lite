import { describe, expect, it } from "vitest";

import { createBoxData } from "../../../packages/babylon-lite/src/mesh/create-box";

function boundsOf(positions: Float32Array): { minimum: number[]; maximum: number[] } {
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < positions.length; index += 3) {
        for (let axis = 0; axis < 3; axis++) {
            minimum[axis] = Math.min(minimum[axis]!, positions[index + axis]!);
            maximum[axis] = Math.max(maximum[axis]!, positions[index + axis]!);
        }
    }
    return { minimum, maximum };
}

describe("createBoxData", () => {
    it("creates independent width, height, and depth dimensions", () => {
        const bounds = boundsOf(createBoxData({ width: 598, height: 18, depth: 530 }).positions);

        expect(bounds.minimum).toEqual([-299, -9, -265]);
        expect(bounds.maximum).toEqual([299, 9, 265]);
    });

    it("uses size as the fallback for dimensions without an axis override", () => {
        const bounds = boundsOf(createBoxData({ size: 6, width: 8 }).positions);

        expect(bounds.minimum).toEqual([-4, -3, -3]);
        expect(bounds.maximum).toEqual([4, 3, 3]);
    });

    it("keeps scalar size calls backward compatible", () => {
        const bounds = boundsOf(createBoxData(2).positions);

        expect(bounds.minimum).toEqual([-1, -1, -1]);
        expect(bounds.maximum).toEqual([1, 1, 1]);
    });
});
