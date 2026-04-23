import type { BlockEmitter } from "../node-types.js";
import { formatFloat } from "./_math-factory.js";

export const emitter: BlockEmitter = {
    className: "ClampBlock",
    emit(block, _outputName, stage, state, ctx) {
        const value = ctx.resolve(block, "value", stage, state);
        const minRaw = block.serialized.minimum;
        const maxRaw = block.serialized.maximum;
        const minExpr = typeof minRaw === "number" ? formatFloat(minRaw) : "0.0";
        const maxExpr = typeof maxRaw === "number" ? formatFloat(maxRaw) : "1.0";
        return { expr: `clamp(${value.expr}, ${minExpr}, ${maxExpr})`, type: value.type };
    },
};
