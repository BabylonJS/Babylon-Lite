import type { ParticleBlockEvaluator, NpeGetter } from "../npe-types.js";

// Comparison tests, matching the BJS `ParticleConditionBlockTests` enum order.
const TEST_EQUAL = 0;
const TEST_NOT_EQUAL = 1;
const TEST_LESS_THAN = 2;
const TEST_GREATER_THAN = 3;
const TEST_LESS_OR_EQUAL = 4;
const TEST_GREATER_OR_EQUAL = 5;
const TEST_XOR = 6;
const TEST_OR = 7;
const TEST_AND = 8;

/** Mirrors BJS `WithinEpsilon`: true when the absolute difference of a and b is within epsilon. */
function withinEpsilon(a: number, b: number, epsilon: number): boolean {
    return Math.abs(a - b) <= epsilon;
}

function evaluate(test: number, left: number, right: number, epsilon: number): boolean {
    switch (test) {
        case TEST_EQUAL:
            return withinEpsilon(left, right, epsilon);
        case TEST_NOT_EQUAL:
            return !withinEpsilon(left, right, epsilon);
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

/**
 * `ParticleConditionBlock` — compares `left` against `right` with a selectable test (`test` property) and a
 * tolerance (`epsilon`), outputting `ifTrue` when the test passes and `ifFalse` otherwise. Mirrors BJS
 * `ParticleConditionBlock`; used, e.g., to brake a particle's velocity once its speed exceeds the
 * velocity-limit gradient. Unconnected inputs default to BJS values (right 0, ifTrue 1, ifFalse 0).
 */
export const particleConditionBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const test = typeof block.serialized.test === "number" ? block.serialized.test : TEST_EQUAL;
        const epsilon = typeof block.serialized.epsilon === "number" ? block.serialized.epsilon : 0;
        const leftGetter = ctx.input(block, "left", () => 0);
        const rightGetter = ctx.input(block, "right", () => 0);
        const ifTrueGetter = ctx.input(block, "ifTrue", () => 1);
        const ifFalseGetter = ctx.input(block, "ifFalse", () => 0);

        const getter: NpeGetter = (state) => {
            const left = leftGetter(state) as number;
            const right = rightGetter(state) as number;
            return evaluate(test, left, right, epsilon) ? ifTrueGetter(state) : ifFalseGetter(state);
        };
        ctx.setOutput(block.id, "output", getter);
    },
};
