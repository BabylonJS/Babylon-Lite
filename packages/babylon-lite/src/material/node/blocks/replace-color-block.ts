import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "ReplaceColorBlock",
    emit(block, _outputName, stage, state, ctx) {
        const value = ctx.resolve(block, "value", stage, state);
        if (value.type === "f32" || value.type === "mat4f" || value.type === "texture2d" || value.type === "textureCube") {
            throw new Error(`NodeMaterial: ReplaceColorBlock requires a vector/color value; got ${value.type}`);
        }
        const reference = ctx.cast(ctx.resolve(block, "reference", stage, state), value.type).expr;
        const distance = ctx.cast(ctx.resolve(block, "distance", stage, state), "f32").expr;
        const replacement = ctx.cast(ctx.resolve(block, "replacement", stage, state), value.type).expr;
        return { expr: `select(${value.expr}, ${replacement}, length(${value.expr} - ${reference}) < ${distance})`, type: value.type };
    },
};
