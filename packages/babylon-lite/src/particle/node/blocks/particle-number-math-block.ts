import type { NpeBlockEvaluator } from "../npe-build.js";
import type { ScalarGetter } from "../npe-value.js";

const OP_MODULO = 0;
const OP_POW = 1;

/**
 * `ParticleNumberMathBlock` — scalar `left % right` (Modulo, the default) or `Math.pow(left, right)` (Pow). Like
 * Babylon.js, both operands must be connected, and an `Int` left operand truncates the result and types the output
 * `Int`. Unknown operations publish no output.
 */
export const npeBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const operation = typeof block.serialized.operation === "number" ? block.serialized.operation : OP_MODULO;
        if ((operation !== OP_MODULO && operation !== OP_POW) || !ctx.isConnected(block, "left") || !ctx.isConnected(block, "right")) {
            return;
        }
        const left = ctx.input(block, "left") as ScalarGetter;
        const right = ctx.input(block, "right") as ScalarGetter;
        const getter: ScalarGetter = operation === OP_POW ? (i) => Math.pow(left(i), right(i)) : (i) => left(i) % right(i);
        const isInt = ctx.isInt(block, "left");
        ctx.setOutput(block.id, "output", isInt ? (i) => getter(i) | 0 : getter, isInt);
    },
};
