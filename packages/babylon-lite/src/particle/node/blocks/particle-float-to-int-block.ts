import type { NpeBlockEvaluator } from "../npe-build.js";
import type { ScalarGetter } from "../npe-value.js";

const OP_ROUND = 0;
const OP_CEIL = 1;
const OP_FLOOR = 2;
const OP_TRUNCATE = 3;

/** `ParticleFloatToIntBlock` — convert a scalar via round, ceil, floor, or truncate. */
export const particleFloatToIntBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const operation = typeof block.serialized.operation === "number" ? block.serialized.operation : OP_ROUND;
        const input = ctx.input(block, "input", () => 0);
        const getter: ScalarGetter = (i) => {
            const value = input(i) as number;
            switch (operation) {
                case OP_CEIL:
                    return Math.ceil(value);
                case OP_FLOOR:
                    return Math.floor(value);
                case OP_TRUNCATE:
                    return Math.trunc(value);
                default:
                    return Math.round(value);
            }
        };
        ctx.setOutput(block.id, "output", getter);
    },
};
