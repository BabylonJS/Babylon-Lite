import { describe, expect, it } from "vitest";

import { mat4InvertToRefOrIdentity } from "../../../packages/babylon-lite/src/math/mat4-invert-to-ref";
import { mat4Invert } from "../../../packages/babylon-lite/src/math/mat4-invert";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";

describe("mat4InvertToRefOrIdentity", () => {
    it("matches mat4Invert while preserving caller-owned storage", () => {
        const input = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, -6, 7, 1]) as unknown as Mat4;
        const expected = mat4Invert(input);
        const resultStorage = new Float32Array(16);
        const result = resultStorage as unknown as Mat4;
        const resultBuffer = resultStorage.buffer;

        mat4InvertToRefOrIdentity(input, result);

        expect(expected).not.toBeNull();
        expect(resultStorage.buffer).toBe(resultBuffer);
        expect(Array.from(result)).toEqual(Array.from(expected!));
    });

    it("writes a full identity when mat4Invert reports a singular matrix", () => {
        const input = new Float32Array(16) as unknown as Mat4;
        const result = new Float64Array(16).fill(7) as unknown as Mat4;

        expect(mat4Invert(input)).toBeNull();
        mat4InvertToRefOrIdentity(input, result);

        expect(Array.from(result)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    });
});
