import { describe, expect, it } from "vitest";

import type { Mat4, Quat, Vec4 } from "../../../packages/babylon-lite/src/math/types";
import {
    animationTypeForFgType,
    coerceValue,
    defaultForType,
    FgAnimationValueType,
    FgType,
    isFgInt,
    isFgMatrix2D,
    isFgMatrix3D,
} from "../../../packages/babylon-lite/src/flow-graph/index";
import type { FgInteger } from "../../../packages/babylon-lite/src/flow-graph/index";

describe("rich-type defaultForType", () => {
    it("returns the correct defaults per type", () => {
        expect(defaultForType(FgType.Number)).toBe(0);
        expect(defaultForType(FgType.Boolean)).toBe(false);
        expect(defaultForType(FgType.String)).toBe("");
        expect(defaultForType(FgType.Vector3)).toEqual({ x: 0, y: 0, z: 0 });
        expect(defaultForType(FgType.Quaternion)).toEqual({ x: 0, y: 0, z: 0, w: 1 });
        expect(defaultForType(FgType.Color4)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
        expect(isFgInt(defaultForType(FgType.Integer))).toBe(true);
        expect(isFgMatrix2D(defaultForType(FgType.Matrix2D))).toBe(true);
        expect(isFgMatrix3D(defaultForType(FgType.Matrix3D))).toBe(true);
        expect(defaultForType(FgType.Any)).toBe(null);
    });

    it("identity matrix default has 1s on the diagonal", () => {
        const m = defaultForType(FgType.Matrix) as unknown as Mat4;
        expect([m[0], m[5], m[10], m[15]]).toEqual([1, 1, 1, 1]);
        expect(m[1]).toBe(0);
    });

    it("constructs fresh values each call (no shared instances)", () => {
        const a = defaultForType(FgType.Vector3);
        const b = defaultForType(FgType.Vector3);
        expect(a).not.toBe(b);
    });
});

describe("rich-type coerceValue", () => {
    it("Vector4 → Quaternion preserves components", () => {
        const v: Vec4 = { x: 0.1, y: 0.2, z: 0.3, w: 0.9 };
        const q = coerceValue(v, FgType.Quaternion) as Quat;
        expect(q).toEqual({ x: 0.1, y: 0.2, z: 0.3, w: 0.9 });
    });

    it("identity Matrix → identity Quaternion", () => {
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as unknown as Mat4;
        const q = coerceValue(identity, FgType.Quaternion) as Quat;
        expect(q.x).toBeCloseTo(0, 6);
        expect(q.y).toBeCloseTo(0, 6);
        expect(q.z).toBeCloseTo(0, 6);
        expect(q.w).toBeCloseTo(1, 6);
    });

    it("number → integer and back", () => {
        const i = coerceValue(3.9, FgType.Integer) as FgInteger;
        expect(isFgInt(i)).toBe(true);
        expect(i.value).toBe(3); // truncated to 32-bit int
        expect(coerceValue(i, FgType.Number)).toBe(3);
    });

    it("boolean ↔ number/integer coercions", () => {
        expect(coerceValue(true, FgType.Number)).toBe(1);
        expect(coerceValue(false, FgType.Number)).toBe(0);
        expect(coerceValue(0, FgType.Boolean)).toBe(false);
        expect(coerceValue(5, FgType.Boolean)).toBe(true);
    });

    it("passes null/undefined through untouched", () => {
        expect(coerceValue(null, FgType.Quaternion)).toBe(null);
        expect(coerceValue(undefined, FgType.Number)).toBe(undefined);
    });

    it("returns the value unchanged when no conversion applies", () => {
        const v3 = { x: 1, y: 2, z: 3 };
        expect(coerceValue(v3, FgType.Vector3)).toBe(v3);
    });
});

describe("rich-type animationTypeForFgType", () => {
    it("maps each type to its animation value category (quaternion ⇒ slerp)", () => {
        expect(animationTypeForFgType(FgType.Number)).toBe(FgAnimationValueType.Float);
        expect(animationTypeForFgType(FgType.Vector2)).toBe(FgAnimationValueType.Vector2);
        expect(animationTypeForFgType(FgType.Vector3)).toBe(FgAnimationValueType.Vector3);
        expect(animationTypeForFgType(FgType.Quaternion)).toBe(FgAnimationValueType.Quaternion);
        expect(animationTypeForFgType(FgType.Color3)).toBe(FgAnimationValueType.Color3);
        expect(animationTypeForFgType(FgType.Matrix)).toBe(FgAnimationValueType.Matrix);
    });
});
