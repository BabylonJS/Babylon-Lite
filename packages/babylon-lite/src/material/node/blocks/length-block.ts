import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "LengthBlock",
    emit(block, _outputName, stage, state, ctx) {
        const value = ctx.resolve(block, "value", stage, state);
        return { expr: `length(${value.expr})`, type: "f32" };
    },
};
