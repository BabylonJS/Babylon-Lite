import { describe, expect, it } from "vitest";
import { convertMatrix, convertRotation, needsWindingFlip, rotationToDirection } from "../../../../packages/babylon-lite/src/export-gltf/export-handedness";
import { expectClose, rotate } from "./export-test-utils";

describe("handedness", () => {
    it.each([
        [1, 2, 3, 4],
        [-4, 3, 2, -1],
        [1, 0, 0, 1],
        [0, 1, 0, 1],
        [0, 0, 1, 0],
    ])("mirrors a rotated vector across X for quaternion (%s, %s, %s, %s)", (...components) => {
        const q = components.map((value) => value / Math.hypot(...components)) as [number, number, number, number];
        const converted = convertRotation(...q);
        const reference = rotate(q, [-0.3, -1.2, 2.5]);
        expectClose(rotate(converted, [0.3, -1.2, 2.5]), [-reference[0]!, reference[1]!, reference[2]!], 6);
        expect(Math.hypot(...converted)).toBeCloseTo(1, 6);
    });

    it("breaks exact quaternion pivot ties toward y and w", () => {
        const w = Math.sqrt(0.12);
        expectClose(convertRotation(0.6, 0.6, 0.4, w), [-0.6, 0.6, 0.4, -w], 9);
        const s = Math.SQRT1_2;
        expectClose(convertRotation(0, 0, s, s), [0, 0, -s, s], 9);
        expectClose(convertRotation(0, 0, s, -s), [0, 0, s, s], 9);
    });

    it("converts a full matrix without changing its source", () => {
        const source = Float32Array.from({ length: 16 }, (_, i) => i + 1);
        const before = source.slice();
        const result = convertMatrix(source);
        expect(result).toEqual([1, -2, -3, -4, -5, 6, 7, 8, -9, 10, 11, 12, -13, 14, 15, 16]);
        expect(source).toEqual(before);
    });

    it.each([
        [0, 0, -1],
        [0, 0, 5],
        [2, -3, 4],
    ])("orients -Z along direction (%s, %s, %s)", (x, y, z) => {
        const length = Math.hypot(x, y, z);
        expectClose(rotate(rotationToDirection(x, y, z), [0, 0, -1]), [x / length, y / length, z / length], 6);
    });

    it.each([
        [undefined, true, false],
        [1, true, false],
        [-1, true, true],
        [undefined, false, true],
        [1, false, true],
        [-1, false, false],
    ] as const)("selects winding for authoredSign=%s, convert=%s", (sign, convert, expected) => {
        expect(needsWindingFlip(sign, convert)).toBe(expected);
    });
});
