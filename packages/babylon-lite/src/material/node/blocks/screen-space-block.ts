/** ScreenSpaceBlock — transforms a vec3/vec4 by WVP and maps clip XY to 0..1 screen space. */

import type { BlockEmitter, NodeValueType } from "../node-types.js";

const OUTPUTS: Record<string, { readonly swizzle: string; readonly type: NodeValueType }> = {
    output: { swizzle: ".xy", type: "vec2f" },
    x: { swizzle: ".x", type: "f32" },
    y: { swizzle: ".y", type: "f32" },
};

export const emitter: BlockEmitter = {
    className: "ScreenSpaceBlock",
    stage: "fragment",
    emit(block, outputName, stage, state, ctx) {
        const vectorRaw = ctx.resolve(block, "vector", stage, state);
        const vector = vectorRaw.type === "vec4f" ? vectorRaw : ctx.cast(vectorRaw, "vec3f");
        const wvp = ctx.cast(ctx.resolve(block, "worldViewProjection", stage, state), "mat4f");
        const clip = ctx.temp(state, "screenClip");
        const uv = ctx.temp(state, "screenUv");
        const vectorExpr = vector.type === "vec4f" ? vector.expr : `vec4<f32>(${vector.expr}, 1.0)`;
        state.fragment.body.push(`let ${clip} = ${wvp.expr} * ${vectorExpr};`);
        state.fragment.body.push(`let ${uv} = (${clip}.xy / ${clip}.w) * 0.5 + vec2<f32>(0.5, 0.5);`);
        const out = OUTPUTS[outputName];
        if (!out) {
            throw new Error(`NodeMaterial: ScreenSpaceBlock has no output "${outputName}"`);
        }
        return { expr: `${uv}${out.swizzle}`, type: out.type };
    },
};
