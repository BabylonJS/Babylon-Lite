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

/** Annotate connected inputs with their recursively propagated Int type. */
export function resolveParticleValueTypes(blocks: ReadonlyMap<number, ParsedParticleBlock>): void {
    for (const block of blocks.values()) {
        for (const input of block.inputs) {
            if (hasIntInput(blocks, block, input.name, new Set())) {
                (input as { valueType?: string }).valueType = "int";
            }
        }
    }
    for (const block of blocks.values()) {
        if (block.className === "ParticleMathBlock" && hasIntInput(blocks, block, "left", new Set()) && hasIntInput(blocks, block, "right", new Set())) {
            const left = block.inputs.find((input) => input.name === "left");
            const right = block.inputs.find((input) => input.name === "right");
            const alias = left?.targetBlockId === right?.targetBlockId && left?.targetConnectionName === right?.targetConnectionName;
            (block as { className: string }).className = alias ? "ParticleIntMathAliasBlock" : "ParticleIntMathBlock";
        }
    }
}
