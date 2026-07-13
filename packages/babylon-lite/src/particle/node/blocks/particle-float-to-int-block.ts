import type { ParticleBlockEvaluator, NpeGetter } from "../npe-types.js";

// Operations, matching the BJS `ParticleFloatToIntBlockOperations` enum order.
const OP_ROUND = 0;
const OP_CEIL = 1;
const OP_FLOOR = 2;
const OP_TRUNCATE = 3;

function toInt(operation: number, value: number): number {
    switch (operation) {
        case OP_CEIL:
            return Math.ceil(value);
        case OP_FLOOR:
            return Math.floor(value);
        case OP_TRUNCATE:
            return Math.trunc(value);
        case OP_ROUND:
        default:
            return Math.round(value);
    }
}

/**
 * `ParticleFloatToIntBlock` — converts a float input to an int via round/ceil/floor/truncate (selected by
 * the `operation` property). Mirrors BJS `ParticleFloatToIntBlock`; used, e.g., to turn a per-frame emit-rate
 * gradient value into an integer particle count.
 */
export const particleFloatToIntBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const operation = typeof block.serialized.operation === "number" ? block.serialized.operation : OP_ROUND;
        const inputGetter = ctx.input(block, "input", () => 0);
        const getter: NpeGetter = (state) => toInt(operation, inputGetter(state) as number);
        ctx.setOutput(block.id, "output", getter);
    },
};
