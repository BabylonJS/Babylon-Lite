import { describe, expect, it } from "vitest";

import { inverseLerp } from "../../../packages/babylon-lite/src/math/inverse-lerp";

describe("inverseLerp", () => {
    it("bounds the parameter according to either endpoint order", () => {
        expect(inverseLerp(10, 20, 5)).toBe(0);
        expect(inverseLerp(10, 20, 25)).toBe(1);
        expect(inverseLerp(20, 10, 5)).toBe(1);
        expect(inverseLerp(20, 10, 25)).toBe(0);
    });

    it("preserves interior values and endpoint parameters", () => {
        expect(inverseLerp(10, 20, 15)).toBe(0.5);
        expect(inverseLerp(20, 10, 15)).toBe(0.5);
        expect(inverseLerp(20, 10, 20)).toBe(0);
        expect(inverseLerp(20, 10, 10)).toBe(1);
    });

    it("returns zero for identical endpoints and otherwise preserves indeterminate arithmetic", () => {
        expect(inverseLerp(5, 5, 10)).toBe(0);
        expect(inverseLerp(5, 5, NaN)).toBe(0);
        expect(inverseLerp(0, 1, NaN)).toBeNaN();
    });
});
