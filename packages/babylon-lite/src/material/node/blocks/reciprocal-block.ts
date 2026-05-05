import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "ReciprocalBlock",
    emit(block, _outputName, stage, state, ctx) {
        const input = ctx.resolve(block, "input", stage, state);
        if (input.type === "mat4f") {
            return { expr: `inverse(${input.expr})`, type: "mat4f" };
        }
        return { expr: `(1.0 / ${input.expr})`, type: input.type };
    },
};
