/** FragmentOutputBlock emitter.
 *
 *  The fragment root. Reads the `rgba` (or `rgb` + `a`) input, casts to vec4,
 *  and writes it to the fragment main body via an SSA temp so the pipeline
 *  scaffold can emit `return finalColor;`.
 */

import type { BlockEmitter, NodeExpr, NodeValueType } from "../node-types.js";
import { wgsl } from "../../../shader/wgsl.js";

export const emitter: BlockEmitter = {
    className: "FragmentOutputBlock",
    stage: "fragment",
    emit(block, _outputName, stage, state, ctx) {
        const input = (name: string, type: NodeValueType): NodeExpr | null => (block.inputs.get(name)?.source ? ctx.cast(ctx.resolve(block, name, stage, state), type) : null);
        // rgba takes precedence; otherwise combine rgb + a.
        const rgba = input("rgba", "vec4f");
        const rgb = rgba ? null : input("rgb", "vec3f");
        // As in Babylon.js, the glow input (its `additionalColor`) belongs to the material: its uniforms and textures
        // are part of the material's layout and inputs even though only a glow pass outputs it, with `a` when connected.
        const glow = input("glow", "vec3f");
        const a = rgba && !glow ? null : input("a", "f32");
        const t = ctx.temp(state, "frag");
        state.fragment.body.push(wgsl`let ${t} = ${rgba ? rgba.expr : wgsl`vec4<f32>(${rgb ? rgb.expr : "vec3<f32>(0.0, 0.0, 0.0)"}, ${a ? a.expr : "1.0"})`};`);
        state.fragment.body.push(wgsl`_NME_FRAG_OUTPUT_ = ${t};`);
        if (glow) {
            state._glowOutput = [glow, a];
        }
        return { expr: t, type: "vec4f" };
    },
};
