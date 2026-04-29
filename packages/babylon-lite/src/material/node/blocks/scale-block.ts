import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "ScaleBlock",
    emit(block, _outputName, stage, state, ctx) {
        const input = ctx.resolve(block, "input", stage, state);
        const factor = ctx.resolve(block, "factor", stage, state);
        // factor is always scalar in BJS
        const fc = ctx.cast(factor, "f32").expr;
        return { expr: `(${input.expr} * ${fc})`, type: input.type };
    },
};
