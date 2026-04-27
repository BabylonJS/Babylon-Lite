import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "StepBlock",
    emit(block, _outputName, stage, state, ctx) {
        const value = ctx.resolve(block, "value", stage, state);
        const edge = ctx.resolve(block, "edge", stage, state);
        const ec = ctx.cast(edge, value.type).expr;
        return { expr: `step(${ec}, ${value.expr})`, type: value.type };
    },
};
