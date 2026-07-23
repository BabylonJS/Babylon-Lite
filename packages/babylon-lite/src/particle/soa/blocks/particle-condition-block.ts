import type { SoaBlockEvaluator } from "../npe-build.js";
import type { SoaGetter } from "../value.js";

const TEST_EQUAL = 0;
const TEST_NOT_EQUAL = 1;
const TEST_LESS_THAN = 2;
const TEST_GREATER_THAN = 3;
const TEST_LESS_OR_EQUAL = 4;
const TEST_GREATER_OR_EQUAL = 5;
const TEST_XOR = 6;
const TEST_OR = 7;
const TEST_AND = 8;

function evaluate(test: number, left: number, right: number, epsilon: number): boolean {
    switch (test) {
        case TEST_EQUAL:
            return Math.abs(left - right) <= epsilon;
        case TEST_NOT_EQUAL:
            return Math.abs(left - right) > epsilon;
        case TEST_LESS_THAN:
            return left < right + epsilon;
        case TEST_GREATER_THAN:
            return left > right - epsilon;
        case TEST_LESS_OR_EQUAL:
            return left <= right + epsilon;
        case TEST_GREATER_OR_EQUAL:
            return left >= right - epsilon;
        case TEST_XOR:
            return (!!left && !right) || (!left && !!right);
        case TEST_OR:
            return !!left || !!right;
        case TEST_AND:
            return !!left && !!right;
        default:
            return false;
    }
}

/** `ParticleConditionBlock` (SoA) — select one of two values from a scalar comparison. */
export const particleConditionBlock: SoaBlockEvaluator = {
    build(block, ctx) {
        const test = typeof block.serialized.test === "number" ? block.serialized.test : TEST_EQUAL;
        const epsilon = typeof block.serialized.epsilon === "number" ? block.serialized.epsilon : 0;
        const left = ctx.input(block, "left", () => 0);
        const right = ctx.input(block, "right", () => 0);
        const ifTrue = ctx.input(block, "ifTrue", () => 1);
        const ifFalse = ctx.input(block, "ifFalse", () => 0);
        const getter: SoaGetter = (i) => (evaluate(test, left(i) as number, right(i) as number, epsilon) ? ifTrue(i) : ifFalse(i));
        ctx.setOutput(block.id, "output", getter);
    },
};
