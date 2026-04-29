/** FragmentOutputBlock emitter.
 *
 *  The fragment root. Reads the `rgba` (or `rgb` + `a`) input, casts to vec4,
 *  and writes it to the fragment main body via an SSA temp so the pipeline
 *  scaffold can emit `return finalColor;`.
 */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "FragmentOutputBlock",
    stage: "fragment",
    emit(block, _outputName, stage, state, ctx) {
        // rgba takes precedence; otherwise combine rgb + a.
        const rgbaConn = block.inputs.get("rgba");
        let finalVec4;
        if (rgbaConn && rgbaConn.source) {
            const v = ctx.resolve(block, "rgba", stage, state);
            finalVec4 = ctx.cast(v, "vec4f");
        } else {
            const rgbConn = block.inputs.get("rgb");
            const aConn = block.inputs.get("a");
            const rgb = rgbConn && rgbConn.source ? ctx.cast(ctx.resolve(block, "rgb", stage, state), "vec3f") : { expr: "vec3<f32>(0.0, 0.0, 0.0)", type: "vec3f" as const };
            const a = aConn && aConn.source ? ctx.cast(ctx.resolve(block, "a", stage, state), "f32") : { expr: "1.0", type: "f32" as const };
            finalVec4 = { expr: `vec4<f32>(${rgb.expr}, ${a.expr})`, type: "vec4f" as const };
        }
        const t = ctx.temp(state, "frag");
        state.fragment.body.push(`let ${t} = ${finalVec4.expr};`);
        state.fragment.body.push(`_NME_FRAG_OUTPUT_ = ${t};`);
        return { expr: t, type: "vec4f" };
    },
};
