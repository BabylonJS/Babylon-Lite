// ValueInterpolation (BJS FlowGraphInterpolationBlock + PlayAnimation chain,
// glTF ops `variable/interpolate` / `pointer/interpolate`).
//
// Self-contained async execution block. Editor blocks expose the interpolated
// value output. KHR variable/pointer operations additionally read and write the
// target on every tick, coordinating ownership by variable/pointer identity.
//
// Supported interpolation per animation type:
//   Float / Integer: scalar linear lerp.
//   Vector2/3/4, Color3/4: component-wise linear lerp.
//   Quaternion: spherical linear interpolation (slerp), matching BJS `useSlerp`.
//   Matrix: instant snap to endValue (no interpolation defined in BJS).
//
// Config:
//   `type`     — optional FgType string (e.g. "Vector3") for type-aware lerp.
//                If omitted the type is inferred from the startValue at runtime.
//   `useSlerp` — optional boolean; when true, treats values as quaternions and
//                uses slerp regardless of the `type` field.
//
// glTF: `variable/interpolate` maps `value` → `endValue`, `duration` →
// `duration`. Both KHR operations use CSS-style cubic Bezier easing from `p1`
// and `p2`; pointer quaternion accessors automatically use slerp.

import type { FgBlockDef } from "../../block-def.js";
import type { FgPendingTask } from "../../context.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import type { FgValue, Vec2 } from "../../types.js";
import type { Color3, Color4, Quat, Vec3, Vec4 } from "../../../math/types.js";
import { FgAnimationValueType, animationTypeForFgType } from "../../rich-type.js";
import { activateSignal, addPending, cancelPendingForBlock, getDataValue, setDataValue, setExecVar } from "../../runtime.js";
import { sigIn, sigOut, sockIn, sockOut } from "../../sockets.js";
import { pointerTypesCompatible, resolveBlockPointer } from "../../pointer-template.js";

// ─── Interpolation math ───────────────────────────────────────────────────────

/** Spherical linear interpolation for quaternions (BJS-compatible). */
function slerpQuat(a: Quat, b: Quat, t: number): Quat {
    let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    let bx = b.x,
        by = b.y,
        bz = b.z,
        bw = b.w;
    // Take the shortest arc — negate b if dot is negative.
    if (dot < 0) {
        dot = -dot;
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
    }
    let s0: number;
    let s1: number;
    if (dot > 0.9995) {
        // Numerically safe fallback: normalised linear interpolation.
        s0 = 1 - t;
        s1 = t;
    } else {
        const theta = Math.acos(dot);
        const sinTheta = Math.sin(theta);
        s0 = Math.sin((1 - t) * theta) / sinTheta;
        s1 = Math.sin(t * theta) / sinTheta;
    }
    return { x: s0 * a.x + s1 * bx, y: s0 * a.y + s1 * by, z: s0 * a.z + s1 * bz, w: s0 * a.w + s1 * bw };
}

/** Type-aware linear/spherical interpolation between two FgValues. */
function lerpFgValue(a: FgValue, b: FgValue, t: number, animType: FgAnimationValueType): FgValue {
    switch (animType) {
        case FgAnimationValueType.Float: {
            const na = typeof a === "number" ? a : 0;
            const nb = typeof b === "number" ? b : 0;
            return na + t * (nb - na);
        }

        case FgAnimationValueType.Vector2: {
            const va = a as Vec2;
            const vb = b as Vec2;
            return { x: va.x + t * (vb.x - va.x), y: va.y + t * (vb.y - va.y) };
        }
        case FgAnimationValueType.Vector3: {
            const va = a as Vec3;
            const vb = b as Vec3;
            return { x: va.x + t * (vb.x - va.x), y: va.y + t * (vb.y - va.y), z: va.z + t * (vb.z - va.z) };
        }
        case FgAnimationValueType.Vector4: {
            const va = a as Vec4;
            const vb = b as Vec4;
            return { x: va.x + t * (vb.x - va.x), y: va.y + t * (vb.y - va.y), z: va.z + t * (vb.z - va.z), w: va.w + t * (vb.w - va.w) };
        }
        case FgAnimationValueType.Quaternion:
            return slerpQuat(a as Quat, b as Quat, t);
        case FgAnimationValueType.Color3: {
            const ca = a as Color3;
            const cb = b as Color3;
            return { r: ca.r + t * (cb.r - ca.r), g: ca.g + t * (cb.g - ca.g), b: ca.b + t * (cb.b - ca.b) };
        }
        case FgAnimationValueType.Color4: {
            const ca = a as Color4;
            const cb = b as Color4;
            return { r: ca.r + t * (cb.r - ca.r), g: ca.g + t * (cb.g - ca.g), b: ca.b + t * (cb.b - ca.b), a: ca.a + t * (cb.a - ca.a) };
        }
        default:
            // Matrix types: snap to end (no interpolation defined in BJS for matrices).
            return b;
    }
}

function cubicBezier(t: number, p1: Vec2, p2: Vec2): number {
    const sample = (u: number, a: number, b: number) => ((3 * a - 3 * b + 1) * u + (-6 * a + 3 * b)) * u * u + 3 * a * u;
    const derivative = (u: number) => 3 * (3 * p1.x - 3 * p2.x + 1) * u * u + 2 * (-6 * p1.x + 3 * p2.x) * u + 3 * p1.x;
    let u = t;
    for (let i = 0; i < 8; i++) {
        const error = sample(u, p1.x, p2.x) - t;
        if (Math.abs(error) < 1e-7) {
            return sample(u, p1.y, p2.y);
        }
        const slope = derivative(u);
        if (Math.abs(slope) < 1e-7) {
            break;
        }
        u -= error / slope;
    }
    let low = 0;
    let high = 1;
    for (let i = 0; i < 24; i++) {
        u = (low + high) / 2;
        if (sample(u, p1.x, p2.x) < t) {
            low = u;
        } else {
            high = u;
        }
    }
    return sample(u, p1.y, p2.y);
}

function validControlPoint(value: FgValue): value is Vec2 {
    return (
        typeof value === "object" &&
        value !== null &&
        "x" in value &&
        "y" in value &&
        typeof value.x === "number" &&
        typeof value.y === "number" &&
        isFinite(value.x) &&
        isFinite(value.y)
    );
}

/** Derive the `FgAnimationValueType` from config and/or the runtime start value. */
function resolveAnimType(startValue: FgValue, config: Readonly<Record<string, unknown>> | undefined): FgAnimationValueType {
    if (config?.useSlerp) {
        return FgAnimationValueType.Quaternion;
    }
    const configType = config?.type as string | undefined;
    if (configType) {
        return animationTypeForFgType(configType as FgType);
    }
    // Infer from value shape — covers the common test/unit cases.
    if (typeof startValue === "number" || startValue === null || startValue === undefined) {
        return FgAnimationValueType.Float;
    }
    if (typeof startValue === "object") {
        if ("r" in startValue && "a" in startValue) {
            return FgAnimationValueType.Color4;
        }
        if ("r" in startValue) {
            return FgAnimationValueType.Color3;
        }
        // Vec4 and Quat both carry `w`; without an explicit `type`/`useSlerp` in
        // config, prefer Vec4 (linear). Set `config.useSlerp` or `config.type =
        // "Quaternion"` to force slerp.
        if ("w" in startValue) {
            return FgAnimationValueType.Vector4;
        }
        if ("z" in startValue) {
            return FgAnimationValueType.Vector3;
        }
        if ("y" in startValue) {
            return FgAnimationValueType.Vector2;
        }
    }
    return FgAnimationValueType.Float;
}

// ─── Block definition ─────────────────────────────────────────────────────────

export const valueInterpolationDef: FgBlockDef = {
    type: FgBlockType.ValueInterpolation,
    build: (config) => ({
        dataIn: [
            sockIn("startValue", FgType.Any),
            sockIn("endValue", FgType.Any),
            sockIn("duration", FgType.Number, 0),
            sockIn("p1", FgType.Vector2, { x: 0, y: 0 }),
            sockIn("p2", FgType.Vector2, { x: 1, y: 1 }),
            ...((config?.pointerSegments as string[] | undefined) ?? []).map((name) => sockIn(name, FgType.Any)),
        ],
        dataOut: [sockOut("value", FgType.Any)],
        signalIn: [sigIn("in")],
        signalOut: [sigOut("out"), sigOut("done"), sigOut("error")],
    }),
    updateOutputs(block, ctx) {
        // Expose whatever the most recent onTick (or execute) wrote.
        const cv = ctx.executionVariables[`${block.id}:currentValue`];
        if (cv !== undefined) {
            setDataValue(ctx, block, "value", cv as FgValue);
        }
    },
    execute(block, ctx, env, incomingSignal) {
        if (incomingSignal !== "in" && incomingSignal !== undefined) {
            return;
        }

        const duration = getDataValue(ctx, env, block, "duration") as number;
        const p1 = getDataValue(ctx, env, block, "p1");
        const p2 = getDataValue(ctx, env, block, "p2");
        if (!isFinite(duration) || isNaN(duration) || duration < 0 || !validControlPoint(p1) || !validControlPoint(p2) || p1.x < 0 || p1.x > 1 || p2.x < 0 || p2.x > 1) {
            activateSignal(ctx, env, block, "error");
            return;
        }

        let targetKey = `block:${block.id}`;
        let startValue = getDataValue(ctx, env, block, "startValue");
        let writeTarget: ((value: FgValue) => void) | undefined;
        let targetType: FgType | undefined;
        const variable = block.config?.variable as string | undefined;
        if (variable !== undefined) {
            if (!(variable in ctx.userVariables)) {
                activateSignal(ctx, env, block, "error");
                return;
            }
            targetKey = `variable:${variable}`;
            startValue = ctx.userVariables[variable]!;
            writeTarget = (value) => {
                ctx.userVariables[variable] = value;
            };
        } else if (block.config?.accessor || block.config?.pointerTemplate) {
            const resolved = resolveBlockPointer(block, ctx, env);
            if (!resolved?.accessor.set) {
                activateSignal(ctx, env, block, "error");
                return;
            }
            targetKey = `pointer:${resolved.pointer}`;
            startValue = resolved.accessor.get();
            writeTarget = resolved.accessor.set;
            targetType = resolved.accessor.type;
            const declaredType = block.config?.type as FgType | undefined;
            if (!pointerTypesCompatible(declaredType, targetType)) {
                activateSignal(ctx, env, block, "error");
                return;
            }
        }
        const endValue = getDataValue(ctx, env, block, "endValue");
        const animType = resolveAnimType(startValue, targetType ? { ...block.config, type: targetType, useSlerp: targetType === FgType.Quaternion } : block.config);

        // Validation succeeded: replace any interpolation owning this target.
        for (const task of ctx.pending) {
            if (task.state.targetKey === targetKey) {
                task.canceled = true;
            }
        }
        cancelPendingForBlock(ctx, block);

        // Seed the data output with the start value immediately.
        setExecVar(ctx, block, "currentValue", startValue);
        setDataValue(ctx, block, "value", startValue);

        if (duration <= 0 && variable === undefined && !block.config?.accessor && !block.config?.pointerTemplate) {
            // Zero-duration: snap straight to end, fire done synchronously.
            setExecVar(ctx, block, "currentValue", endValue);
            setDataValue(ctx, block, "value", endValue);
            activateSignal(ctx, env, block, "out");
            activateSignal(ctx, env, block, "done");
            return;
        }

        addPending(ctx, block, { startValue, endValue, duration, elapsed: 0, animType, p1, p2, targetKey, writeTarget });
        activateSignal(ctx, env, block, "out");
    },
    onTick(block, ctx, env, deltaMs, task: FgPendingTask) {
        const elapsed = (task.state.elapsed as number) + deltaMs / 1000;
        const duration = task.state.duration as number;
        const startValue = task.state.startValue as FgValue;
        const endValue = task.state.endValue as FgValue;
        const animType = task.state.animType as FgAnimationValueType;
        const writeTarget = task.state.writeTarget as ((value: FgValue) => void) | undefined;

        if (elapsed >= duration) {
            task.done = true;
            setExecVar(ctx, block, "currentValue", endValue);
            setDataValue(ctx, block, "value", endValue);
            writeTarget?.(endValue);
            activateSignal(ctx, env, block, "done");
        } else {
            task.state.elapsed = elapsed;
            const t = elapsed / duration;
            if (t <= 0) {
                return;
            }
            const current = lerpFgValue(startValue, endValue, cubicBezier(t, task.state.p1 as Vec2, task.state.p2 as Vec2), animType);
            setExecVar(ctx, block, "currentValue", current);
            setDataValue(ctx, block, "value", current);
            writeTarget?.(current);
        }
    },
    cancelPending(_block, _ctx, _env) {
        // No external resources (file handles, subscriptions) to release.
    },
};
