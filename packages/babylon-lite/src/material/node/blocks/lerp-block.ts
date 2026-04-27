import type { BlockEmitter } from "../node-types.js";
import { widerType } from "./_math-factory.js";

export const emitter: BlockEmitter = {
    className: "LerpBlock",
    emit(block, _outputName, stage, state, ctx) {
        const left = ctx.resolve(block, "left", stage, state);
        const right = ctx.resolve(block, "right", stage, state);
        const gradient = ctx.resolve(block, "gradient", stage, state);
        const t = widerType(left.type, right.type);
        const lc = ctx.cast(left, t).expr;
        const rc = ctx.cast(right, t).expr;
        // Gradient can be scalar (broadcast) or vector (per-component). Cast to result type.
        const gc = ctx.cast(gradient, t).expr;
        return { expr: `mix(${lc}, ${rc}, ${gc})`, type: t };
    },
};
