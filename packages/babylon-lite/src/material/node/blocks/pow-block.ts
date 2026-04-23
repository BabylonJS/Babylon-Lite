import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "PowBlock",
    emit(block, _outputName, stage, state, ctx) {
        const v = ctx.resolve(block, "value", stage, state);
        const p = ctx.resolve(block, "power", stage, state);
        const pc = ctx.cast(p, v.type).expr;
        return { expr: `pow(${v.expr}, ${pc})`, type: v.type };
    },
};
