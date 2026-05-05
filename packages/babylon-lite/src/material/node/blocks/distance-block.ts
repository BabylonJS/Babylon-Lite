import type { BlockEmitter } from "../node-types.js";
import { widerType } from "./_math-factory.js";

export const emitter: BlockEmitter = {
    className: "DistanceBlock",
    emit(block, _outputName, stage, state, ctx) {
        const left = ctx.resolve(block, "left", stage, state);
        const right = ctx.resolve(block, "right", stage, state);
        const type = widerType(left.type, right.type);
        const lc = ctx.cast(left, type).expr;
        const rc = ctx.cast(right, type).expr;
        return { expr: `length(${lc} - ${rc})`, type: "f32" };
    },
};
