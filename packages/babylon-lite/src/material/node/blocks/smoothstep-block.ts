import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "SmoothStepBlock",
    emit(block, _outputName, stage, state, ctx) {
        const value = ctx.resolve(block, "value", stage, state);
        const edge0 = ctx.resolve(block, "edge0", stage, state);
        const edge1 = ctx.resolve(block, "edge1", stage, state);
        const e0 = ctx.cast(edge0, value.type).expr;
        const e1 = ctx.cast(edge1, value.type).expr;
        return { expr: `smoothstep(${e0}, ${e1}, ${value.expr})`, type: value.type };
    },
};
