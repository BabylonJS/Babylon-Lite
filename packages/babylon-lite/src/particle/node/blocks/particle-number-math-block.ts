import type { NpeBlockEvaluator } from "../npe-build.js";
import type { ScalarGetter } from "../npe-value.js";

const OP_MODULO = 0;
const OP_POW = 1;

/** `ParticleNumberMathBlock` — scalar remainder or power with Int-left result coercion. */
export const particleNumberMathBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        if (!ctx.isConnected(block, "left")) {
            throw new Error(`NodeParticle: ParticleNumberMathBlock ${block.id} input "left" is not connected`);
        }
        if (!ctx.isConnected(block, "right")) {
            throw new Error(`NodeParticle: ParticleNumberMathBlock ${block.id} input "right" is not connected`);
        }
        const operation = typeof block.serialized.operation === "number" ? block.serialized.operation : OP_MODULO;
        if (operation !== OP_MODULO && operation !== OP_POW) {
            throw new Error(`NodeParticle: ParticleNumberMathBlock ${block.id} has unsupported operation ${operation}`);
        }
        const left = ctx.input(block, "left");
        const right = ctx.input(block, "right");
        const intResult = block.inputs.find((input) => input.name === "left")?.valueType === "int";
        const getter: ScalarGetter = (i) => {
            const leftValue = left(i);
            const rightValue = right(i);
            if (typeof leftValue !== "number" || typeof rightValue !== "number") {
                throw new Error(`NodeParticle: ParticleNumberMathBlock ${block.id} received an unsupported value`);
            }
            const result = operation === OP_MODULO ? leftValue % rightValue : Math.pow(leftValue, rightValue);
            return intResult ? result | 0 : result;
        };
        ctx.setOutput(block.id, "output", getter);
    },
};
