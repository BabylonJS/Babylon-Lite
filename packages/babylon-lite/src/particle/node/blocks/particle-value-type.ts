import type { ParsedParticleBlock } from "../npe-types.js";

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

/** Resolve whether a named block input carries Babylon's Int connection type. */
export function hasIntBlockInput(blocks: ReadonlyMap<number, ParsedParticleBlock> | undefined, block: ParsedParticleBlock, inputName: string): boolean {
    return blocks !== undefined && hasIntInput(blocks, block, inputName, new Set());
}
