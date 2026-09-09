import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import type * as Lite from "../../../packages/babylon-lite/src/index";
import type { Mat4, Vec3, Vec3Tuple } from "../../../packages/babylon-lite/src/math/types";
import { normalizeVec3 } from "../../../packages/babylon-lite/src/math/normalize-vec3";
import { normalizeVec3TupleOrUp } from "../../../packages/babylon-lite/src/math/normalize-vec3-tuple-or-up";
import { normalizeVec3InPlace, normalizeVec3ToRef } from "../../../packages/babylon-lite/src/math/vec3-ref";
import { createIdentityMat4 } from "../../../packages/babylon-lite/src/math/create-identity-mat4";
import { createMat4FromQuat, writeMat4FromQuatIntoBuffer } from "../../../packages/babylon-lite/src/math/create-mat4-from-quat";
import { eulerXYZToQuatTuple, quatToEulerXYZTuple } from "../../../packages/babylon-lite/src/math/quat-euler";
import { maximizeMat4InPlace } from "../../../packages/babylon-lite/src/math/maximize-mat4-in-place";
import { scaleBoundsFromCenterToRef } from "../../../packages/babylon-lite/src/math/scale-bounds-from-center-to-ref";
import { allocateF64Mat4 } from "../../../packages/babylon-lite/src/math/_mat4-storage-f64";
import { _resetMatrixAllocatorForTests, _setHpmAllocator } from "../../../packages/babylon-lite/src/math/_matrix-allocator";

afterEach(() => _resetMatrixAllocatorForTests());

describe("public math contracts", () => {
    it("exposes explicit representations without legacy aliases", () => {
        type LegacyNames =
            | "normalizeVec3Object"
            | "subVec3"
            | "subVec3ToRef"
            | "subVec3InPlace"
            | "mat4Identity"
            | "mat4Translation"
            | "mat4Scale"
            | "mat4LookAtLH"
            | "mat4PerspectiveLH"
            | "mat4Compose"
            | "mat4Decompose"
            | "mat4Multiply"
            | "mat4Invert"
            | "mat4FromQuat"
            | "mat4FromQuatInto"
            | "quatFromRotationMatrix"
            | "quatFromLookDirectionRH"
            | "eulerToQuat"
            | "quatToEulerXYZ";
        expectTypeOf<Extract<keyof typeof Lite, LegacyNames>>().toEqualTypeOf<never>();
        expectTypeOf<ReturnType<typeof Lite.normalizeVec3>>().toEqualTypeOf<Vec3>();
        expectTypeOf<ReturnType<typeof Lite.normalizeVec3TupleOrUp>>().toEqualTypeOf<Vec3Tuple>();
        expectTypeOf<Parameters<typeof Lite.normalizeVec3>>().toEqualTypeOf<[v: Vec3]>();
        expectTypeOf<ReturnType<typeof Lite.createMat4FromQuat>>().toEqualTypeOf<Mat4>();
        expectTypeOf<Parameters<typeof Lite.createMat4FromQuat>>().toEqualTypeOf<[qx: number, qy: number, qz: number, qw: number]>();
        expectTypeOf<ReturnType<typeof Lite.eulerXYZToQuatTuple>>().toEqualTypeOf<[number, number, number, number]>();
        expectTypeOf<ReturnType<typeof Lite.quatToEulerXYZTuple>>().toEqualTypeOf<[number, number, number]>();
        expectTypeOf<ReturnType<typeof Lite.scaleBoundsFromCenterToRef>>().toEqualTypeOf<void>();
    });

    it("keeps object normalization fallbacks consistent at the threshold", () => {
        const epsilon = 1e-10;
        for (const length of [0, epsilon / 2, epsilon, epsilon * 2, 5]) {
            const source = { x: length, y: 0, z: 0 };
            const result = { x: -1, y: -1, z: -1 };
            const target = { ...source };
            const expected = { x: length <= epsilon ? 0 : 1, y: 0, z: 0 };
            expect(normalizeVec3(source)).toEqual(expected);
            expect(normalizeVec3ToRef(source, result, epsilon)).toBe(result);
            expect(normalizeVec3InPlace(target, epsilon)).toBe(target);
            expect(result).toEqual(expected);
            expect(target).toEqual(expected);
            expect(source.x).toBe(length);
        }
        expect(normalizeVec3({ x: 1e-10, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
        expect(normalizeVec3TupleOrUp(0, 0, 0)).toEqual([0, 1, 0]);
    });

    it("keeps tuple conversion and raw-buffer kernels independent of object wrappers", () => {
        const quat = eulerXYZToQuatTuple(0.2, 0.3, 0.4);
        const angles = quatToEulerXYZTuple(...quat);
        angles.forEach((angle, index) => expect(angle).toBeCloseTo([0.2, 0.3, 0.4][index]!));
        const matrix = createMat4FromQuat(...quat);
        const storage = new Float32Array(16);
        expect(writeMat4FromQuatIntoBuffer(storage, ...quat)).toBe(storage);
        expect([...storage]).toEqual(Array.from(matrix));
    });

    it("maximizes allocator-owned matrices without losing F64 precision or allocating a result", () => {
        _setHpmAllocator(allocateF64Mat4);
        const target = createIdentityMat4();
        const other = new Float64Array(16).fill(1 + 2 ** -40);
        const result = maximizeMat4InPlace(target, other);
        expectTypeOf(result).toEqualTypeOf<Mat4>();
        expect(result).toBe(target);
        expect(result).toBeInstanceOf(Float64Array);
        expect(result[0]).toBe(1 + 2 ** -40);
        const raw = new Float32Array(16);
        expect(maximizeMat4InPlace(raw, other)).toBe(raw);
    });

    it("scales bounds directly into both output vectors without a return wrapper", () => {
        const minimum = { x: -1, y: -2, z: -3 };
        const maximum = { x: 1, y: 2, z: 3 };
        const center = { x: 0, y: 0, z: 0 };
        expect(scaleBoundsFromCenterToRef(minimum, maximum, center, 2, minimum, maximum)).toBeUndefined();
        expect(minimum.x).toBeCloseTo(-2);
        expect(minimum.y).toBeCloseTo(-4);
        expect(minimum.z).toBeCloseTo(-6);
        expect(maximum.x).toBeCloseTo(2);
        expect(maximum.y).toBeCloseTo(4);
        expect(maximum.z).toBeCloseTo(6);
    });
});
