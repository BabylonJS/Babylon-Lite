import type { BlockEmitter } from "../node-types.js";

// Matches BJS `TrigonometryBlockOperations` enum.
const OP: Record<number, string> = {
    0: "cos",
    1: "sin",
    2: "abs",
    3: "exp",
    4: "exp2",
    5: "round",
    6: "floor",
    7: "ceil",
    8: "sqrt",
    9: "log",
    10: "tan",
    11: "atan",
    12: "acos",
    13: "asin",
    14: "fract",
    15: "sign",
    16: "radians",
    17: "degrees",
};

export const emitter: BlockEmitter = {
    className: "TrigonometryBlock",
    emit(block, _outputName, stage, state, ctx) {
        const input = ctx.resolve(block, "input", stage, state);
        const opIdx = block.serialized.operation;
        const fn = typeof opIdx === "number" ? OP[opIdx] : undefined;
        if (!fn) {
            throw new Error(`NodeMaterial: unknown TrigonometryBlock operation ${String(opIdx)}`);
        }
        return { expr: `${fn}(${input.expr})`, type: input.type };
    },
};
