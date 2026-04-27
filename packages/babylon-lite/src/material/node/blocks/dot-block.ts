import type { BlockEmitter } from "../node-types.js";
import { widerType } from "./_math-factory.js";

export const emitter: BlockEmitter = {
    className: "DotBlock",
    emit(block, _outputName, stage, state, ctx) {
        const l = ctx.resolve(block, "left", stage, state);
        const r = ctx.resolve(block, "right", stage, state);
        const t = widerType(l.type, r.type);
        const lc = ctx.cast(l, t).expr;
        const rc = ctx.cast(r, t).expr;
        return { expr: `dot(${lc}, ${rc})`, type: "f32" };
    },
};
