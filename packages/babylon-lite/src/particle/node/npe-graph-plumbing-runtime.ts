import type { ParticleGraph, ParsedParticleBlock, ParsedParticleInput } from "./npe-types.js";

interface SourcePair {
    readonly blockId: number;
    readonly connectionName: string;
}

function isConnected(input: ParsedParticleInput | undefined): input is ParsedParticleInput & { targetBlockId: number; targetConnectionName: string } {
    return input?.targetBlockId != null && input.targetConnectionName != null;
}

function cycleError(stack: readonly number[], repeatedId: number): Error {
    const start = stack.indexOf(repeatedId);
    const cycle = [...stack.slice(start), repeatedId].join(" -> ");
    return new Error(`NodeParticle: graph plumbing cycle ${cycle}`);
}

/** @internal Normalize reachable Teleport routes without mutating the parsed graph. */
export function normalizeNodeParticleGraphRuntime(graph: ParticleGraph): ParticleGraph {
    const resolvedSources = new Map<string, SourcePair>();

    const resolveSource = (blockId: number, connectionName: string, stack: readonly number[]): SourcePair => {
        const cacheKey = `${blockId}:${connectionName}`;
        const cached = resolvedSources.get(cacheKey);
        if (cached) {
            return cached;
        }

        const block = graph.blocks.get(blockId);
        if (!block) {
            return { blockId, connectionName };
        }
        if (block.className === "ParticleTeleportInBlock") {
            throw new Error(`NodeParticle: ParticleTeleportInBlock ${block.id} does not expose output "${connectionName}"`);
        }
        if (block.className !== "ParticleTeleportOutBlock") {
            const terminal = { blockId, connectionName };
            resolvedSources.set(cacheKey, terminal);
            return terminal;
        }
        if (connectionName !== "output") {
            throw new Error(`NodeParticle: ParticleTeleportOutBlock ${block.id} does not expose output "${connectionName}"`);
        }
        if (stack.includes(block.id)) {
            throw cycleError(stack, block.id);
        }

        const entryPoint = block.serialized.entryPoint;
        if (typeof entryPoint !== "number" || !Number.isFinite(entryPoint) || !Number.isInteger(entryPoint) || entryPoint < 0) {
            throw new Error(`NodeParticle: ParticleTeleportOutBlock ${block.id} has invalid entryPoint`);
        }
        const endpoint = graph.blocks.get(entryPoint);
        if (!endpoint) {
            throw new Error(`NodeParticle: ParticleTeleportOutBlock ${block.id} references missing entryPoint ${entryPoint}`);
        }
        if (endpoint.className !== "ParticleTeleportInBlock") {
            throw new Error(`NodeParticle: ParticleTeleportOutBlock ${block.id} entryPoint ${entryPoint} is not ParticleTeleportInBlock`);
        }
        if (stack.includes(endpoint.id)) {
            throw cycleError(stack, endpoint.id);
        }
        const input = endpoint.inputs.find((candidate) => candidate.name === "input");
        if (!isConnected(input)) {
            throw new Error(`NodeParticle: ParticleTeleportInBlock ${endpoint.id} input is not connected`);
        }

        const resolved = resolveSource(input.targetBlockId, input.targetConnectionName, [...stack, block.id, endpoint.id]);
        resolvedSources.set(cacheKey, resolved);
        return resolved;
    };

    const visited = new Set<number>();
    let changedBlocks: Map<number, ParsedParticleBlock> | undefined;
    const visitBlock = (blockId: number): void => {
        if (visited.has(blockId)) {
            return;
        }
        visited.add(blockId);
        const block = graph.blocks.get(blockId);
        if (!block) {
            return;
        }

        let inputs: ParsedParticleInput[] | undefined;
        const visitInput = (input: ParsedParticleInput, index: number): void => {
            if (!isConnected(input)) {
                return;
            }
            const resolved = resolveSource(input.targetBlockId, input.targetConnectionName, []);
            if (resolved.blockId !== input.targetBlockId || resolved.connectionName !== input.targetConnectionName) {
                inputs ??= block.inputs.slice();
                inputs[index] = { ...input, targetBlockId: resolved.blockId, targetConnectionName: resolved.connectionName };
            }
            visitBlock(resolved.blockId);
        };

        for (let index = 0; index < block.inputs.length; index++) {
            if (block.inputs[index]!.name === "particle") {
                visitInput(block.inputs[index]!, index);
            }
        }
        for (let index = 0; index < block.inputs.length; index++) {
            if (block.inputs[index]!.name !== "particle") {
                visitInput(block.inputs[index]!, index);
            }
        }
        if (inputs) {
            (changedBlocks ??= new Map()).set(block.id, { ...block, inputs });
        }
    };

    for (const systemId of graph.systemBlockIds) {
        visitBlock(systemId);
    }
    if (!changedBlocks) {
        return graph._isGraphPlumbingNormalized ? graph : { blocks: graph.blocks, systemBlockIds: graph.systemBlockIds, _isGraphPlumbingNormalized: true };
    }

    const blocks = new Map(graph.blocks);
    for (const [blockId, block] of changedBlocks) {
        blocks.set(blockId, block);
    }
    return { blocks, systemBlockIds: graph.systemBlockIds, _isGraphPlumbingNormalized: true };
}
