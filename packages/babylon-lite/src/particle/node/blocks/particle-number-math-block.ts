import type { NpeBlockEvaluator } from "../npe-build.js";
import type { ParsedParticleBlock } from "../npe-types.js";
import type { ScalarGetter } from "../npe-value.js";

const OP_MODULO = 0;
const OP_POW = 1;

function hasIntOutput(blocks: ReadonlyMap<number, ParsedParticleBlock>, blockId: number, visiting: Set<number>): boolean {
    if (visiting.has(blockId)) {
        return false;
    }
    const block = blocks.get(blockId);
    if (!block) {
        return false;
    }
    if (block.className === "ParticleInputBlock") {
        return block.serialized.type === 0x0001;
    }
    if (block.className === "ParticleFloatToIntBlock") {
        return true;
    }
    if (block.className === "ParticleNumberMathBlock" || block.className === "ParticleClampBlock" || block.className === "ParticleStepBlock") {
        visiting.add(blockId);
        const inputName = block.className === "ParticleNumberMathBlock" ? "left" : "value";
        const input = block.inputs.find((candidate) => candidate.name === inputName);
        const result = input?.targetBlockId != null && hasIntOutput(blocks, input.targetBlockId, visiting);
        visiting.delete(blockId);
        return result;
    }
    return false;
}

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
        const leftInput = block.inputs.find((input) => input.name === "left");
        const intResult =
            leftInput?.valueType === "int" || (leftInput?.targetBlockId != null && ctx._blocks !== undefined && hasIntOutput(ctx._blocks, leftInput.targetBlockId, new Set()));
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
