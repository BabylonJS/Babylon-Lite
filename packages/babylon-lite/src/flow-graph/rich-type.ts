// Pure replacements for the three things a BJS `RichType` instance carried:
// a default value, a typeTransformer (coercion), and an animationType.
// No classes, no module-level instances — three pure functions, allocating
// only inside the function body.

import { quatFromRotationMatrix } from "../math/quat-from-rotation-matrix.js";
import type { Color3, Color4, Mat4, Quat, Vec3, Vec4 } from "../math/types.js";
import { fgInt, isFgInt } from "./custom-types/fg-integer.js";
import { fgMatrix2D, fgMatrix3D } from "./custom-types/fg-matrix.js";
import type { FgValue, Vec2 } from "./types.js";
import { FgType } from "./types.js";

/** Keyframe value categories an interpolation/animation block must distinguish.
 *  Replaces BJS `RichType.animationType`; quaternion targets must use slerp. */
export const FgAnimationValueType = {
    Float: 0,
    Vector2: 1,
    Vector3: 2,
    Vector4: 3,
    Quaternion: 4,
    Color3: 5,
    Color4: 6,
    Matrix: 7,
} as const;
export type FgAnimationValueType = (typeof FgAnimationValueType)[keyof typeof FgAnimationValueType];

/** The default value for a type. Constructs fresh values inside the function
 *  (no shared module-level instances). Replaces `RichType.defaultValue`. */
export function defaultForType(type: FgType): FgValue {
    switch (type) {
        case FgType.Number:
            return 0;
        case FgType.Integer:
            return fgInt(0);
        case FgType.Boolean:
            return false;
        case FgType.String:
        case FgType.Reference:
            return "";
        case FgType.Vector2:
            return { x: 0, y: 0 } as Vec2;
        case FgType.Vector3:
            return { x: 0, y: 0, z: 0 } as Vec3;
        case FgType.Vector4:
            return { x: 0, y: 0, z: 0, w: 0 } as Vec4;
        case FgType.Quaternion:
            return { x: 0, y: 0, z: 0, w: 1 } as Quat;
        case FgType.Matrix:
            // Identity 4x4, column-major, branded as Mat4 by convention.
            return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as unknown as Mat4;
        case FgType.Matrix2D:
            return fgMatrix2D();
        case FgType.Matrix3D:
            return fgMatrix3D();
        case FgType.Color3:
            return { r: 0, g: 0, b: 0 } as Color3;
        case FgType.Color4:
            return { r: 0, g: 0, b: 0, a: 1 } as Color4;
        case FgType.Any:
        default:
            return null;
    }
}

/** Coerce `value` to `target`. Home of BJS's `typeTransformer`, including the
 *  critical `Vector4`/`Matrix` → `Quaternion` and numeric↔integer conversions.
 *  Invoked by `getDataValue` at the consumer boundary so block bodies stay
 *  type-clean. Returns `value` unchanged when no conversion is needed/possible. */
export function coerceValue(value: FgValue, target: FgType): FgValue {
    if (value === null || value === undefined) {
        return value;
    }
    switch (target) {
        case FgType.Number:
            if (isFgInt(value)) {
                return value.value;
            }
            if (typeof value === "boolean") {
                return value ? 1 : 0;
            }
            return value;
        case FgType.Integer:
            if (typeof value === "number") {
                return fgInt(value);
            }
            if (typeof value === "boolean") {
                return fgInt(value ? 1 : 0);
            }
            return value;
        case FgType.Boolean:
            if (isFgInt(value)) {
                return value.value !== 0;
            }
            if (typeof value === "number") {
                return value !== 0;
            }
            return value;
        case FgType.Quaternion:
            return toQuaternion(value);
        default:
            return value;
    }
}

/** `Vector4` (x,y,z,w) and `Matrix` (rotation) both coerce to `Quaternion`.
 *  glTF `useSlerp` targets force this so interpolation runs as slerp. */
function toQuaternion(value: FgValue): FgValue {
    // A Vec4 already has x,y,z,w — reinterpret as a quaternion directly.
    if (value && typeof value === "object" && "w" in value && "x" in value && "y" in value && "z" in value) {
        const v = value as Vec4;
        return { x: v.x, y: v.y, z: v.z, w: v.w } as Quat;
    }
    // A 4x4 matrix → extract its rotation as a quaternion.
    if (value instanceof Float32Array && value.length === 16) {
        return quatFromRotationMatrix(value as unknown as Mat4);
    }
    return value;
}

/** The animation value category for a type. Replaces `RichType.animationType`;
 *  used by interpolation/animation blocks to pick the keyframe interpolation
 *  (quaternion ⇒ slerp). */
export function animationTypeForFgType(type: FgType): FgAnimationValueType {
    switch (type) {
        case FgType.Vector2:
            return FgAnimationValueType.Vector2;
        case FgType.Vector3:
            return FgAnimationValueType.Vector3;
        case FgType.Vector4:
            return FgAnimationValueType.Vector4;
        case FgType.Quaternion:
            return FgAnimationValueType.Quaternion;
        case FgType.Color3:
            return FgAnimationValueType.Color3;
        case FgType.Color4:
            return FgAnimationValueType.Color4;
        case FgType.Matrix:
        case FgType.Matrix2D:
        case FgType.Matrix3D:
            return FgAnimationValueType.Matrix;
        default:
            return FgAnimationValueType.Float;
    }
}
