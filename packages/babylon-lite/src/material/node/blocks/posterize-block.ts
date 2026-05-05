import type { BlockEmitter, NodeValueType } from "../node-types.js";

function one(type: NodeValueType): string {
    if (type === "f32") {
        return "1.0";
    }
    if (type === "vec2f") {
        return "vec2<f32>(1.0)";
    }
    if (type === "vec3f") {
        return "vec3<f32>(1.0)";
    }
    if (type === "vec4f") {
        return "vec4<f32>(1.0)";
    }
    throw new Error(`NodeMaterial: PosterizeBlock does not support ${type}`);
}

export const emitter: BlockEmitter = {
    className: "PosterizeBlock",
    emit(block, _outputName, stage, state, ctx) {
        const value = ctx.resolve(block, "value", stage, state);
        const steps = ctx.cast(ctx.resolve(block, "steps", stage, state), value.type).expr;
        const interval = `(${one(value.type)} / ${steps})`;
        return { expr: `(floor(${value.expr} / ${interval}) * ${interval})`, type: value.type };
    },
};
