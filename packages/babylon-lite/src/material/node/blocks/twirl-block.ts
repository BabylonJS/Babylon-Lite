/** TwirlBlock — rotates a vec2 around a center by strength * distance, then adds offset. */

import type { BlockEmitter, NodeValueType } from "../node-types.js";

const OUTPUTS: Record<string, { readonly swizzle: string; readonly type: NodeValueType }> = {
    output: { swizzle: "", type: "vec2f" },
    x: { swizzle: ".x", type: "f32" },
    y: { swizzle: ".y", type: "f32" },
};

function defaultVec2(expr: string): { readonly expr: string; readonly type: "vec2f" } {
    return { expr, type: "vec2f" };
}

function defaultF32(expr: string): { readonly expr: string; readonly type: "f32" } {
    return { expr, type: "f32" };
}

export const emitter: BlockEmitter = {
    className: "TwirlBlock",
    stage: "fragment",
    emit(block, outputName, stage, state, ctx) {
        const input = ctx.cast(ctx.resolve(block, "input", stage, state), "vec2f");
        const strength = ctx.cast(block.inputs.get("strength")?.source ? ctx.resolve(block, "strength", stage, state) : defaultF32("1.0"), "f32");
        const center = ctx.cast(block.inputs.get("center")?.source ? ctx.resolve(block, "center", stage, state) : defaultVec2("vec2<f32>(0.5, 0.5)"), "vec2f");
        const offset = ctx.cast(block.inputs.get("offset")?.source ? ctx.resolve(block, "offset", stage, state) : defaultVec2("vec2<f32>(0.0, 0.0)"), "vec2f");
        const delta = ctx.temp(state, "twirlDelta");
        const angle = ctx.temp(state, "twirlAngle");
        const result = ctx.temp(state, "twirl");
        state.fragment.body.push(`let ${delta} = ${input.expr} - ${center.expr};`);
        state.fragment.body.push(`let ${angle} = ${strength.expr} * length(${delta});`);
        state.fragment.body.push(
            `let ${result} = vec2<f32>(cos(${angle}) * ${delta}.x - sin(${angle}) * ${delta}.y, sin(${angle}) * ${delta}.x + cos(${angle}) * ${delta}.y) + ${center.expr} + ${offset.expr};`
        );
        const out = OUTPUTS[outputName];
        if (!out) {
            throw new Error(`NodeMaterial: TwirlBlock has no output "${outputName}"`);
        }
        return { expr: `${result}${out.swizzle}`, type: out.type };
    },
};
