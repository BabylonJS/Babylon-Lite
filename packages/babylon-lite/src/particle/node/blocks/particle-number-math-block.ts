import type { NpeBlockEvaluator } from "../npe-build.js";
import type { ParsedParticleBlock } from "../npe-types.js";
import type { ScalarGetter } from "../npe-value.js";

const OP_MODULO = 0;
const OP_POW = 1;

function hasIntInput(blocks: ReadonlyMap<number, ParsedParticleBlock>, block: ParsedParticleBlock, inputName: string, visiting: Set<number>): boolean {
    const input = block.inputs.find((candidate) => candidate.name === inputName);
    return (
        input?.valueType === "int" ||
        (input?.targetBlockId != null && input.targetConnectionName != null && hasIntOutput(blocks, input.targetBlockId, input.targetConnectionName, visiting))
    );
}

function hasIntOutput(blocks: ReadonlyMap<number, ParsedParticleBlock>, blockId: number, outputName: string, visiting: Set<number>): boolean {
    if (visiting.has(blockId)) {
        return false;
    }
    const block = blocks.get(blockId);
    if (!block || outputName !== "output") {
        return false;
    }
    if (block.className === "ParticleInputBlock") {
        return block.serialized.type === 0x0001;
    }
    if (block.className === "ParticleFloatToIntBlock") {
        return true;
    }
    visiting.add(blockId);
    let result = false;
    switch (block.className) {
        case "ParticleMathBlock":
            result = hasIntInput(blocks, block, "left", visiting) && hasIntInput(blocks, block, "right", visiting);
            break;
        case "ParticleConditionBlock":
            result = hasIntInput(blocks, block, "ifTrue", visiting);
            break;
        case "ParticleNumberMathBlock":
        case "ParticleLerpBlock":
            result = hasIntInput(blocks, block, "left", visiting);
            break;
        case "ParticleRandomBlock":
            result = hasIntInput(blocks, block, "min", visiting);
            break;
        case "ParticleLocalVariableBlock":
            result = hasIntInput(blocks, block, "input", visiting);
            break;
        case "ParticleClampBlock":
        case "ParticleStepBlock":
            result = hasIntInput(blocks, block, "value", visiting);
            break;
    }
    visiting.delete(blockId);
    return result;
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
            leftInput?.valueType === "int" ||
            (leftInput?.targetBlockId != null &&
                leftInput.targetConnectionName != null &&
                ctx._blocks !== undefined &&
                hasIntOutput(ctx._blocks, leftInput.targetBlockId, leftInput.targetConnectionName, new Set()));
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
