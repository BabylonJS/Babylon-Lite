import { describe, expect, it } from "vitest";

import {
    getGaussianPointSplattingPackedShBytesPerSplat,
    hasGaussianPointSplattingProjectedDepth,
} from "../../../packages/babylon-lite/src/math/gaussian-point-splatting-compat-helpers";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";

describe("Gaussian Point Splatting compat helpers", () => {
    it("detects projection terms that make depth depend on view-space x or y", () => {
        const projection = new Float32Array(16);
        const hasProjectedDepth = () => hasGaussianPointSplattingProjectedDepth(projection as unknown as Mat4);

        expect(hasProjectedDepth()).toBe(false);
        projection[2] = 1;
        expect(hasProjectedDepth()).toBe(true);
        projection[2] = 0;
        projection[7] = 1;
        expect(hasProjectedDepth()).toBe(true);
    });

    it.each([
        [-1, 0],
        [0, 0],
        [1, 12],
        [2, 24],
        [3, 48],
        [4, 72],
    ])("returns %i SH-degree packed bytes", (degree, expected) => {
        expect(getGaussianPointSplattingPackedShBytesPerSplat(degree)).toBe(expected);
    });
});
