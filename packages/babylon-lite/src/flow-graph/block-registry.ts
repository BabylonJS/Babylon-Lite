// Tree-shakable, side-effect-free block-def registry. Returns a lazy loader for
// one block def, or `null` for an unknown type. Each `case` dynamic-imports a
// single block module so unused blocks are code-split and never fetched — zero
// bytes for scenes without interactivity. Mirrors BJS `blockFactory` and Lite's
// `gltf-feature-registry`.
//
// Phase 2 lands the vertical-slice blocks (events, control-flow, one math op,
// property/variable data, animation). Add one `case` per block as more land
// (Phase 3+). The `switch` body stays pure (no module-level allocation),
// keeping this module fully tree-shakable.
//
// Unknown-op policy lives in the CALLER: `createFgEnv` (KHR_interactivity path)
// fails loudly on `null`; a permissive editor path (post-MVP) may substitute a
// no-op. Never silently swallow an unknown op on the KHR path.

import type { FgBlockDef } from "./block-def.js";
import { FgBlockType } from "./block-type.js";

export function getBlockDef(type: string): (() => Promise<FgBlockDef>) | null {
    switch (type) {
        // ─── Events ───────────────────────────────────────────────
        case FgBlockType.SceneStart:
            return async () => (await import("./blocks/events/scene-start.js")).sceneStartDef;
        case FgBlockType.SceneTick:
            return async () => (await import("./blocks/events/scene-tick.js")).sceneTickDef;
        case FgBlockType.OnSelect:
            return async () => (await import("./blocks/events/on-select.js")).onSelectDef;
        case FgBlockType.SendCustomEvent:
            return async () => (await import("./blocks/events/send-custom-event.js")).sendCustomEventDef;
        case FgBlockType.ReceiveCustomEvent:
            return async () => (await import("./blocks/events/receive-custom-event.js")).receiveCustomEventDef;

        // ─── Control flow ─────────────────────────────────────────
        case FgBlockType.Branch:
            return async () => (await import("./blocks/control-flow/branch.js")).branchDef;
        case FgBlockType.Sequence:
            return async () => (await import("./blocks/control-flow/sequence.js")).sequenceDef;
        case FgBlockType.Switch:
            return async () => (await import("./blocks/control-flow/switch.js")).switchDef;
        case FgBlockType.ForLoop:
            return async () => (await import("./blocks/control-flow/for-loop.js")).forLoopDef;
        case FgBlockType.WhileLoop:
            return async () => (await import("./blocks/control-flow/while-loop.js")).whileLoopDef;
        case FgBlockType.DoN:
            return async () => (await import("./blocks/control-flow/do-n.js")).doNDef;
        case FgBlockType.MultiGate:
            return async () => (await import("./blocks/control-flow/multi-gate.js")).multiGateDef;
        case FgBlockType.WaitAll:
            return async () => (await import("./blocks/control-flow/wait-all.js")).waitAllDef;
        case FgBlockType.Throttle:
            return async () => (await import("./blocks/control-flow/throttle.js")).throttleDef;
        case FgBlockType.SetDelay:
            return async () => (await import("./blocks/control-flow/set-delay.js")).setDelayDef;
        case FgBlockType.CancelDelay:
            return async () => (await import("./blocks/control-flow/cancel-delay.js")).cancelDelayDef;

        // ─── Math ─────────────────────────────────────────────────
        case FgBlockType.Add:
            return async () => (await import("./blocks/math/add.js")).addDef;
        case FgBlockType.Subtract:
            return async () => (await import("./blocks/math/subtract.js")).subtractDef;
        case FgBlockType.Multiply:
            return async () => (await import("./blocks/math/multiply.js")).multiplyDef;
        case FgBlockType.Divide:
            return async () => (await import("./blocks/math/divide.js")).divideDef;
        case FgBlockType.Modulo:
            return async () => (await import("./blocks/math/modulo.js")).moduloDef;
        case FgBlockType.Abs:
            return async () => (await import("./blocks/math/abs.js")).absDef;
        case FgBlockType.Floor:
            return async () => (await import("./blocks/math/floor.js")).floorDef;
        case FgBlockType.LessThan:
            return async () => (await import("./blocks/math/less-than.js")).lessThanDef;
        case FgBlockType.Clamp:
            return async () => (await import("./blocks/math/clamp.js")).clampDef;
        case FgBlockType.CombineVector2:
            return async () => (await import("./blocks/math/combine2.js")).combine2Def;
        case FgBlockType.ExtractVector2:
            return async () => (await import("./blocks/math/extract2.js")).extract2Def;

        // ─── Math: Phase 3 (scalar / trig / compare / bitwise / vector) ──
        case FgBlockType.Negation:
            return async () => (await import("./blocks/math/negation.js")).negationDef;
        case FgBlockType.Sign:
            return async () => (await import("./blocks/math/sign.js")).signDef;
        case FgBlockType.Ceil:
            return async () => (await import("./blocks/math/ceil.js")).ceilDef;
        case FgBlockType.Round:
            return async () => (await import("./blocks/math/round.js")).roundDef;
        case FgBlockType.Trunc:
            return async () => (await import("./blocks/math/trunc.js")).truncDef;
        case FgBlockType.Fraction:
            return async () => (await import("./blocks/math/fraction.js")).fractionDef;
        case FgBlockType.Saturate:
            return async () => (await import("./blocks/math/saturate.js")).saturateDef;
        case FgBlockType.SquareRoot:
            return async () => (await import("./blocks/math/square-root.js")).squareRootDef;
        case FgBlockType.CubeRoot:
            return async () => (await import("./blocks/math/cube-root.js")).cubeRootDef;
        case FgBlockType.Exponential:
            return async () => (await import("./blocks/math/exponential.js")).exponentialDef;
        case FgBlockType.Log:
            return async () => (await import("./blocks/math/log.js")).logDef;
        case FgBlockType.Log2:
            return async () => (await import("./blocks/math/log2.js")).log2Def;
        case FgBlockType.Log10:
            return async () => (await import("./blocks/math/log10.js")).log10Def;
        case FgBlockType.DegToRad:
            return async () => (await import("./blocks/math/deg-to-rad.js")).degToRadDef;
        case FgBlockType.RadToDeg:
            return async () => (await import("./blocks/math/rad-to-deg.js")).radToDegDef;
        case FgBlockType.Sin:
            return async () => (await import("./blocks/math/sin.js")).sinDef;
        case FgBlockType.Cos:
            return async () => (await import("./blocks/math/cos.js")).cosDef;
        case FgBlockType.Tan:
            return async () => (await import("./blocks/math/tan.js")).tanDef;
        case FgBlockType.Asin:
            return async () => (await import("./blocks/math/asin.js")).asinDef;
        case FgBlockType.Acos:
            return async () => (await import("./blocks/math/acos.js")).acosDef;
        case FgBlockType.Atan:
            return async () => (await import("./blocks/math/atan.js")).atanDef;
        case FgBlockType.Sinh:
            return async () => (await import("./blocks/math/sinh.js")).sinhDef;
        case FgBlockType.Cosh:
            return async () => (await import("./blocks/math/cosh.js")).coshDef;
        case FgBlockType.Tanh:
            return async () => (await import("./blocks/math/tanh.js")).tanhDef;
        case FgBlockType.Asinh:
            return async () => (await import("./blocks/math/asinh.js")).asinhDef;
        case FgBlockType.Acosh:
            return async () => (await import("./blocks/math/acosh.js")).acoshDef;
        case FgBlockType.Atanh:
            return async () => (await import("./blocks/math/atanh.js")).atanhDef;
        case FgBlockType.Min:
            return async () => (await import("./blocks/math/min.js")).minDef;
        case FgBlockType.Max:
            return async () => (await import("./blocks/math/max.js")).maxDef;
        case FgBlockType.Power:
            return async () => (await import("./blocks/math/power.js")).powerDef;
        case FgBlockType.Atan2:
            return async () => (await import("./blocks/math/atan2.js")).atan2Def;
        case FgBlockType.Equality:
            return async () => (await import("./blocks/math/equality.js")).equalityDef;
        case FgBlockType.LessThanOrEqual:
            return async () => (await import("./blocks/math/less-than-or-equal.js")).lessThanOrEqualDef;
        case FgBlockType.GreaterThan:
            return async () => (await import("./blocks/math/greater-than.js")).greaterThanDef;
        case FgBlockType.GreaterThanOrEqual:
            return async () => (await import("./blocks/math/greater-than-or-equal.js")).greaterThanOrEqualDef;
        case FgBlockType.IsNaN:
            return async () => (await import("./blocks/math/is-nan.js")).isNaNDef;
        case FgBlockType.IsInfinity:
            return async () => (await import("./blocks/math/is-infinity.js")).isInfinityDef;
        case FgBlockType.BitwiseAnd:
            return async () => (await import("./blocks/math/bitwise-and.js")).bitwiseAndDef;
        case FgBlockType.BitwiseOr:
            return async () => (await import("./blocks/math/bitwise-or.js")).bitwiseOrDef;
        case FgBlockType.BitwiseXor:
            return async () => (await import("./blocks/math/bitwise-xor.js")).bitwiseXorDef;
        case FgBlockType.BitwiseNot:
            return async () => (await import("./blocks/math/bitwise-not.js")).bitwiseNotDef;
        case FgBlockType.BitwiseLeftShift:
            return async () => (await import("./blocks/math/bitwise-left-shift.js")).bitwiseLeftShiftDef;
        case FgBlockType.BitwiseRightShift:
            return async () => (await import("./blocks/math/bitwise-right-shift.js")).bitwiseRightShiftDef;
        case FgBlockType.LeadingZeros:
            return async () => (await import("./blocks/math/leading-zeros.js")).leadingZerosDef;
        case FgBlockType.TrailingZeros:
            return async () => (await import("./blocks/math/trailing-zeros.js")).trailingZerosDef;
        case FgBlockType.OneBitsCounter:
            return async () => (await import("./blocks/math/one-bits-counter.js")).oneBitsCounterDef;
        case FgBlockType.Length:
            return async () => (await import("./blocks/math/length.js")).lengthDef;
        case FgBlockType.Normalize:
            return async () => (await import("./blocks/math/normalize.js")).normalizeDef;
        case FgBlockType.Dot:
            return async () => (await import("./blocks/math/dot.js")).dotDef;
        case FgBlockType.Cross:
            return async () => (await import("./blocks/math/cross.js")).crossDef;
        case FgBlockType.Rotate2D:
            return async () => (await import("./blocks/math/rotate2d.js")).rotate2DDef;
        case FgBlockType.Rotate3D:
            return async () => (await import("./blocks/math/rotate3d.js")).rotate3DDef;
        case FgBlockType.MathInterpolation:
            return async () => (await import("./blocks/math/mix.js")).mathInterpolationDef;
        case FgBlockType.CombineVector3:
            return async () => (await import("./blocks/math/combine3.js")).combine3Def;
        case FgBlockType.CombineVector4:
            return async () => (await import("./blocks/math/combine4.js")).combine4Def;
        case FgBlockType.ExtractVector3:
            return async () => (await import("./blocks/math/extract3.js")).extract3Def;
        case FgBlockType.ExtractVector4:
            return async () => (await import("./blocks/math/extract4.js")).extract4Def;
        case FgBlockType.E:
            return async () => (await import("./blocks/math/constant-e.js")).eDef;
        case FgBlockType.PI:
            return async () => (await import("./blocks/math/constant-pi.js")).piDef;
        case FgBlockType.Inf:
            return async () => (await import("./blocks/math/constant-inf.js")).infDef;
        case FgBlockType.NaN:
            return async () => (await import("./blocks/math/constant-nan.js")).nanDef;
        case FgBlockType.Random:
            return async () => (await import("./blocks/math/random.js")).randomDef;
        case FgBlockType.Conditional:
            return async () => (await import("./blocks/math/conditional.js")).conditionalDef;
        case FgBlockType.DataSwitch:
            return async () => (await import("./blocks/math/data-switch.js")).dataSwitchDef;

        // ─── Math: Phase 3f (matrix + quaternion) ────────────────────────────
        case FgBlockType.TransformVector:
            return async () => (await import("./blocks/math/transform-vector.js")).transformVectorDef;
        case FgBlockType.CombineMatrix2D:
            return async () => (await import("./blocks/math/combine-matrix2d.js")).combineMatrix2DDef;
        case FgBlockType.CombineMatrix3D:
            return async () => (await import("./blocks/math/combine-matrix3d.js")).combineMatrix3DDef;
        case FgBlockType.CombineMatrix:
            return async () => (await import("./blocks/math/combine-matrix.js")).combineMatrixDef;
        case FgBlockType.ExtractMatrix2D:
            return async () => (await import("./blocks/math/extract-matrix2d.js")).extractMatrix2DDef;
        case FgBlockType.ExtractMatrix3D:
            return async () => (await import("./blocks/math/extract-matrix3d.js")).extractMatrix3DDef;
        case FgBlockType.ExtractMatrix:
            return async () => (await import("./blocks/math/extract-matrix.js")).extractMatrixDef;
        case FgBlockType.Transpose:
            return async () => (await import("./blocks/math/transpose.js")).transposeDef;
        case FgBlockType.Determinant:
            return async () => (await import("./blocks/math/determinant.js")).determinantDef;
        case FgBlockType.InvertMatrix:
            return async () => (await import("./blocks/math/invert-matrix.js")).invertMatrixDef;
        case FgBlockType.MatrixMultiplication:
            return async () => (await import("./blocks/math/matrix-multiplication.js")).matrixMultiplicationDef;
        case FgBlockType.MatrixCompose:
            return async () => (await import("./blocks/math/matrix-compose.js")).matrixComposeDef;
        case FgBlockType.MatrixDecompose:
            return async () => (await import("./blocks/math/matrix-decompose.js")).matrixDecomposeDef;
        case FgBlockType.Conjugate:
            return async () => (await import("./blocks/math/quat-conjugate.js")).quatConjugateDef;
        case FgBlockType.AngleBetween:
            return async () => (await import("./blocks/math/angle-between.js")).angleBetweenDef;
        case FgBlockType.QuaternionFromAxisAngle:
            return async () => (await import("./blocks/math/quaternion-from-axis-angle.js")).quaternionFromAxisAngleDef;
        case FgBlockType.AxisAngleFromQuaternion:
            return async () => (await import("./blocks/math/axis-angle-from-quaternion.js")).axisAngleFromQuaternionDef;
        case FgBlockType.QuaternionFromDirections:
            return async () => (await import("./blocks/math/quaternion-from-directions.js")).quaternionFromDirectionsDef;
        case FgBlockType.BooleanToFloat:
            return async () => (await import("./blocks/conversion/boolean-to-float.js")).booleanToFloatDef;
        case FgBlockType.BooleanToInt:
            return async () => (await import("./blocks/conversion/boolean-to-int.js")).booleanToIntDef;
        case FgBlockType.FloatToBoolean:
            return async () => (await import("./blocks/conversion/float-to-boolean.js")).floatToBooleanDef;
        case FgBlockType.IntToBoolean:
            return async () => (await import("./blocks/conversion/int-to-boolean.js")).intToBooleanDef;
        case FgBlockType.IntToFloat:
            return async () => (await import("./blocks/conversion/int-to-float.js")).intToFloatDef;
        case FgBlockType.FloatToInt:
            return async () => (await import("./blocks/conversion/float-to-int.js")).floatToIntDef;

        // ─── Data: property / variable ────────────────────────────
        case FgBlockType.GetProperty:
            return async () => (await import("./blocks/data/get-property.js")).getPropertyDef;
        case FgBlockType.SetProperty:
            return async () => (await import("./blocks/data/set-property.js")).setPropertyDef;
        case FgBlockType.GetVariable:
            return async () => (await import("./blocks/data/get-variable.js")).getVariableDef;
        case FgBlockType.SetVariable:
            return async () => (await import("./blocks/data/set-variable.js")).setVariableDef;
        case FgBlockType.Constant:
            return async () => (await import("./blocks/data/constant.js")).constantDef;

        // ─── Animation ────────────────────────────────────────────
        case FgBlockType.PlayAnimation:
            return async () => (await import("./blocks/animation/play-animation.js")).playAnimationDef;
        case FgBlockType.StopAnimation:
            return async () => (await import("./blocks/animation/stop-animation.js")).stopAnimationDef;
        case FgBlockType.ValueInterpolation:
            return async () => (await import("./blocks/animation/value-interpolation.js")).valueInterpolationDef;

        // ─── Debug ────────────────────────────────────────────────
        case FgBlockType.ConsoleLog:
            return async () => (await import("./blocks/debug/console-log.js")).consoleLogDef;

        default:
            return null;
    }
}
