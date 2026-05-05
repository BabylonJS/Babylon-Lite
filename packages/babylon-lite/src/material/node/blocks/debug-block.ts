import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "NodeMaterialDebugBlock",
    emit(block, _outputName, stage, state, ctx) {
        const input = block.inputs.get("debug");
        if (!input?.source) {
            return { expr: "0.0", type: "f32" };
        }
        return ctx.resolve(block, "debug", stage, state);
    },
};
