import { describe, expect, it } from "vitest";

import { invertMat4ToRefOrIdentity } from "../../../packages/babylon-lite/src/math/invert-mat4-to-ref-or-identity";
import { invertMat4 } from "../../../packages/babylon-lite/src/math/invert-mat4";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";

describe("invertMat4ToRefOrIdentity", () => {
    it("matches invertMat4 while preserving caller-owned storage", () => {
        const input = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, -6, 7, 1]) as unknown as Mat4;
        const expected = invertMat4(input);
        const resultStorage = new Float32Array(16);
        const result = resultStorage as unknown as Mat4;
        const resultBuffer = resultStorage.buffer;

        invertMat4ToRefOrIdentity(input, result);

        expect(expected).not.toBeNull();
        expect(resultStorage.buffer).toBe(resultBuffer);
        expect(Array.from(result)).toEqual(Array.from(expected!));
    });

    it("writes a full identity when invertMat4 reports a singular matrix", () => {
        const input = new Float32Array(16) as unknown as Mat4;
        const result = new Float64Array(16).fill(7) as unknown as Mat4;

        expect(invertMat4(input)).toBeNull();
        invertMat4ToRefOrIdentity(input, result);

        expect(Array.from(result)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    });

    it("uses the same near-singular determinant threshold as invertMat4", () => {
        const belowThreshold = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 9e-11]) as unknown as Mat4;
        const belowResult = new Float32Array(16).fill(7) as unknown as Mat4;

        expect(invertMat4(belowThreshold)).toBeNull();
        invertMat4ToRefOrIdentity(belowThreshold, belowResult);
        expect(Array.from(belowResult)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

        const aboveThreshold = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1.1e-10]) as unknown as Mat4;
        const expected = invertMat4(aboveThreshold);
        const aboveResult = new Float32Array(16) as unknown as Mat4;

        expect(expected).not.toBeNull();
        invertMat4ToRefOrIdentity(aboveThreshold, aboveResult);
        expect(Array.from(aboveResult)).toEqual(Array.from(expected!));
    });
});
