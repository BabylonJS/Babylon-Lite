import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "ArcTan2Block",
    emit(block, _outputName, stage, state, ctx) {
        const x = ctx.cast(ctx.resolve(block, "x", stage, state), "f32").expr;
        const y = ctx.cast(ctx.resolve(block, "y", stage, state), "f32").expr;
        return { expr: `atan2(${x}, ${y})`, type: "f32" };
    },
};
