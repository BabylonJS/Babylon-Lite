import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "ElbowBlock",
    emit(block, _outputName, stage, state, ctx) {
        return ctx.resolve(block, "input", stage, state);
    },
};
