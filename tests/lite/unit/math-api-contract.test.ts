import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import type * as Lite from "../../../packages/babylon-lite/src/index";
import type { Mat4, Vec3, Vec3Tuple } from "../../../packages/babylon-lite/src/math/types";
import { normalizeVec3 } from "../../../packages/babylon-lite/src/math/normalize-vec3";
import { normalizeVec3TupleOrUp } from "../../../packages/babylon-lite/src/math/normalize-vec3-tuple-or-up";
import { normalizeVec3InPlace, normalizeVec3ToRef } from "../../../packages/babylon-lite/src/math/vec3-ref";
import { createIdentityMat4 } from "../../../packages/babylon-lite/src/math/create-identity-mat4";
import { createMat4FromQuat, writeMat4FromQuatIntoBuffer } from "../../../packages/babylon-lite/src/math/create-mat4-from-quat";
import { eulerXYZToQuatTuple, quatToEulerXYZTuple } from "../../../packages/babylon-lite/src/math/quat-euler";
import { quatToBabylonAlphaBetaGammaTuple, quatToBabylonEulerTuple } from "../../../packages/babylon-lite/src/math/quat-babylon-euler";
import { maximizeMat4InPlace } from "../../../packages/babylon-lite/src/math/maximize-mat4-in-place";
import { scaleBoundsFromCenterToRef } from "../../../packages/babylon-lite/src/math/scale-bounds-from-center-to-ref";
import { allocateF64Mat4 } from "../../../packages/babylon-lite/src/math/_mat4-storage-f64";
import { _resetMatrixAllocatorForTests, _setHpmAllocator } from "../../../packages/babylon-lite/src/math/_matrix-allocator";

afterEach(() => _resetMatrixAllocatorForTests());

function babylonEulerToQuat(pitch: number, yaw: number, roll: number): [number, number, number, number] {
    const halfRoll = roll * 0.5;
    const halfPitch = pitch * 0.5;
    const halfYaw = yaw * 0.5;
    const sinRoll = Math.sin(halfRoll);
    const cosRoll = Math.cos(halfRoll);
    const sinPitch = Math.sin(halfPitch);
    const cosPitch = Math.cos(halfPitch);
    const sinYaw = Math.sin(halfYaw);
    const cosYaw = Math.cos(halfYaw);
    return [
        cosYaw * sinPitch * cosRoll + sinYaw * cosPitch * sinRoll,
        sinYaw * cosPitch * cosRoll - cosYaw * sinPitch * sinRoll,
        cosYaw * cosPitch * sinRoll - sinYaw * sinPitch * cosRoll,
        cosYaw * cosPitch * cosRoll + sinYaw * sinPitch * sinRoll,
    ];
}

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
        expectTypeOf<ReturnType<typeof Lite.quatToBabylonEulerTuple>>().toEqualTypeOf<[number, number, number]>();
        expectTypeOf<ReturnType<typeof Lite.quatToBabylonAlphaBetaGammaTuple>>().toEqualTypeOf<[number, number, number]>();
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

    it("matches Babylon.js quaternion Euler semantics close to gimbal lock", () => {
        for (const pitch of [1.5, 1.57, 1.5707, -1.5707]) {
            const source = babylonEulerToQuat(pitch, -0.4, 0.5);
            const angles = quatToBabylonEulerTuple(...source);
            const roundTrip = babylonEulerToQuat(...angles);
            const dot = Math.abs(source.reduce((sum, component, index) => sum + component * roundTrip[index]!, 0));
            expect(dot).toBeCloseTo(1, 10);
        }

        expect(quatToBabylonEulerTuple(Math.SQRT1_2, 0, 0, Math.SQRT1_2)).toEqual([Math.PI / 2, 0, 0]);
        expect(quatToBabylonEulerTuple(0, 0, 0, 0)).toEqual([-0, 0, 0]);
        expect(quatToBabylonAlphaBetaGammaTuple(0, 0, 0, 1)).toEqual([0, 0, 0]);
        const alphaBetaGamma = quatToBabylonAlphaBetaGammaTuple(-0.1477122548121324, 0.31319142525134736, 0.5394409818317512, 0.7675256660514629);
        expect(alphaBetaGamma[0]).toBeCloseTo(-1.3988725439669016, 12);
        expect(alphaBetaGamma[1]).toBeCloseTo(0.7071993743850375, 12);
        expect(alphaBetaGamma[2]).toBeCloseTo(2.624119683291794, 12);
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
        scaleBoundsFromCenterToRef(minimum, maximum, center, 2, minimum, maximum);
        expect(minimum.x).toBeCloseTo(-2);
        expect(minimum.y).toBeCloseTo(-4);
        expect(minimum.z).toBeCloseTo(-6);
        expect(maximum.x).toBeCloseTo(2);
        expect(maximum.y).toBeCloseTo(4);
        expect(maximum.z).toBeCloseTo(6);
    });
});
