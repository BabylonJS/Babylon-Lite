import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "StorageWriteBlock",
    emit(block, _outputName, stage, state, ctx) {
        const value = ctx.resolve(block, "value", stage, state);
        return value;
    },
};
