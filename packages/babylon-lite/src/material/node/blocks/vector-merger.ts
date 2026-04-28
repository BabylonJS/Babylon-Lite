/** VectorMergerBlock emitter.
 *
 *  Combines up to 4 scalar/vector inputs into a vector output. BJS input names:
 *  `xyIn`, `zwIn`, `xyzIn`, `x`, `y`, `z`, `w`. Outputs: `xyzw`, `xyz`, `xy`.
 *  Unconnected inputs default to 0.
 */

import type { BlockEmitter, NodeExpr, NodeEmitContext, NodeBuildState, NodeBlock, Stage } from "../node-types.js";

function tryResolve(block: NodeBlock, inputName: string, stage: Stage, state: NodeBuildState, ctx: NodeEmitContext): NodeExpr | null {
    const input = block.inputs.get(inputName);
    if (!input || !input.source) {
        return null;
    }
    return ctx.resolve(block, inputName, stage, state);
}

function tryResolveAny(block: NodeBlock, inputNames: string[], stage: Stage, state: NodeBuildState, ctx: NodeEmitContext): NodeExpr | null {
    for (const inputName of inputNames) {
        const resolved = tryResolve(block, inputName, stage, state, ctx);
        if (resolved) {
            return resolved;
        }
    }
    return null;
}

export const emitter: BlockEmitter = {
    className: "VectorMergerBlock",
    emit(block, outputName, stage, state, ctx) {
        // Resolve optional inputs. Prefer bundle (xyzIn/xyIn/zwIn) over scalar (x/y/z/w).
        const xyzIn = tryResolveAny(block, ["xyzIn", "xyz"], stage, state, ctx);
        const xyIn = tryResolveAny(block, ["xyIn", "xy"], stage, state, ctx);
        const zwIn = tryResolveAny(block, ["zwIn", "zw"], stage, state, ctx);
        const x = tryResolve(block, "x", stage, state, ctx);
        const y = tryResolve(block, "y", stage, state, ctx);
        const z = tryResolve(block, "z", stage, state, ctx);
        const w = tryResolve(block, "w", stage, state, ctx);

        const sx = x ? ctx.cast(x, "f32").expr : xyIn ? `(${xyIn.expr}).x` : xyzIn ? `(${xyzIn.expr}).x` : "0.0";
        const sy = y ? ctx.cast(y, "f32").expr : xyIn ? `(${xyIn.expr}).y` : xyzIn ? `(${xyzIn.expr}).y` : "0.0";
        const sz = z ? ctx.cast(z, "f32").expr : zwIn ? `(${zwIn.expr}).x` : xyzIn ? `(${xyzIn.expr}).z` : "0.0";
        const sw = w ? ctx.cast(w, "f32").expr : zwIn ? `(${zwIn.expr}).y` : "0.0";

        if (outputName === "xy") {
            return { expr: `vec2<f32>(${sx}, ${sy})`, type: "vec2f" };
        }
        if (outputName === "xyz") {
            return { expr: `vec3<f32>(${sx}, ${sy}, ${sz})`, type: "vec3f" };
        }
        // Default to xyzw.
        return { expr: `vec4<f32>(${sx}, ${sy}, ${sz}, ${sw})`, type: "vec4f" };
    },
};
