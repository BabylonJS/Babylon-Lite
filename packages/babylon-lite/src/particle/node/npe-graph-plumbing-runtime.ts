import type { ParticleGraph, ParsedParticleBlock, ParsedParticleInput } from "./npe-types.js";

type SourcePair = readonly [blockId: number, connectionName: string];

type ConnectionRole = "" | "particle flow" | "system flow" | "texture" | "gradient metadata";

const PARTICLE_DOMAIN = 1;
const SYSTEM_DOMAIN = 2;
function isConnected(input: ParsedParticleInput | undefined): input is ParsedParticleInput & { targetBlockId: number; targetConnectionName: string } {
    return input?.targetBlockId != null && input.targetConnectionName != null;
}

function cyclePath(stack: readonly number[], repeatedId: number): string {
    return stack.slice(stack.indexOf(repeatedId)).concat(repeatedId).join(" -> ");
}

function connectionRole(block: ParsedParticleBlock, input: ParsedParticleInput): ConnectionRole {
    if (input.name === "particle") {
        return "particle flow";
    }
    if (/^(system|on(Start|End))$/.test(input.name)) {
        return "system flow";
    }
    if (
        (block.className === "SystemBlock" && input.name === "texture") ||
        (block.className === "UpdateFlowMapBlock" && input.name === "flowMap") ||
        (block.className === "UpdateNoiseBlock" && input.name === "noiseTexture")
    ) {
        return "texture";
    }
    if (block.className === "ParticleGradientBlock" && input.name.startsWith("value")) {
        return "gradient metadata";
    }
    return "";
}

/** @internal Normalize reachable graph-plumbing routes without mutating the parsed graph. */
export function normalizeNodeParticleGraphRuntime(graph: ParticleGraph): ParticleGraph {
    const resolvedSources = new Map<string, SourcePair>();

    const resolveSource = (blockId: number, connectionName: string, role: ConnectionRole, stack: readonly number[]): SourcePair => {
        const cacheKey = `${blockId}:${connectionName}:${role}`;
        const cached = resolvedSources.get(cacheKey);
        if (cached) {
            return cached;
        }

        const block = graph.blocks.get(blockId);
        if (!block) {
            return [blockId, connectionName];
        }
        if (block.className === "ParticleTeleportInBlock") {
            throw new Error(`NodeParticle: ParticleTeleportInBlock ${block.id} does not expose output "${connectionName}"`);
        }

        switch (block.className) {
            case "ParticleTeleportOutBlock":
            case "ParticleElbowBlock":
            case "ParticleDebugBlock":
            case "ParticleLocalVariableBlock":
                break;
            default: {
                const terminal: SourcePair = [blockId, connectionName];
                resolvedSources.set(cacheKey, terminal);
                return terminal;
            }
        }
        if (connectionName !== "output") {
            throw new Error(`NodeParticle: ${block.className} ${block.id} does not expose output "${connectionName}"`);
        }
        if (stack.includes(block.id)) {
            throw new Error(`NodeParticle: graph plumbing cycle ${cyclePath(stack, block.id)}`);
        }
        if ((block.className === "ParticleDebugBlock" || block.className === "ParticleLocalVariableBlock") && role) {
            throw new Error(`NodeParticle: ${block.className} ${block.id} does not support ${role} connections`);
        }

        if (block.className === "ParticleTeleportOutBlock") {
            const entryPoint = block.serialized.entryPoint;
            if (typeof entryPoint !== "number" || !Number.isInteger(entryPoint) || entryPoint < 0) {
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
                throw new Error(`NodeParticle: graph plumbing cycle ${cyclePath(stack, endpoint.id)}`);
            }
            const input = endpoint.inputs.find((candidate) => candidate.name === "input");
            if (!isConnected(input)) {
                throw new Error(`NodeParticle: ParticleTeleportInBlock ${endpoint.id} input is not connected`);
            }

            const resolved = resolveSource(input.targetBlockId, input.targetConnectionName, role, [...stack, block.id, endpoint.id]);
            resolvedSources.set(cacheKey, resolved);
            return resolved;
        }

        const input = block.inputs.find((candidate) => candidate.name === "input");
        if (!isConnected(input)) {
            throw new Error(`NodeParticle: ${block.className} ${block.id} input is not connected`);
        }
        if (block.className === "ParticleLocalVariableBlock") {
            const terminal: SourcePair = [blockId, connectionName];
            resolvedSources.set(cacheKey, terminal);
            return terminal;
        }
        const resolved = resolveSource(input.targetBlockId, input.targetConnectionName, role, [...stack, block.id]);
        resolvedSources.set(cacheKey, resolved);
        return resolved;
    };

    const visitedDomains = new Map<number, number>();
    let blocks: Map<number, ParsedParticleBlock> | undefined;
    const visitBlock = (blockId: number, incomingDomain: number): void => {
        const visited = visitedDomains.get(blockId) ?? 0;
        const domain = visited | incomingDomain;
        if (domain === visited) {
            return;
        }
        visitedDomains.set(blockId, domain);
        const block = graph.blocks.get(blockId);
        if (!block) {
            return;
        }
        if (block.className === "ParticleLocalVariableBlock" && block.serialized.scope === 0 && (domain & SYSTEM_DOMAIN) !== 0) {
            throw new Error(`NodeParticle: ParticleLocalVariableBlock ${block.id} Particle scope requires particle-only evaluation`);
        }

        let inputs: ParsedParticleInput[] | undefined;
        const visitInput = (input: ParsedParticleInput, index: number): void => {
            if (!isConnected(input)) {
                return;
            }
            const role = connectionRole(block, input);
            const [resolvedBlockId, resolvedConnectionName] = resolveSource(input.targetBlockId, input.targetConnectionName, role, []);
            if (resolvedBlockId !== input.targetBlockId || resolvedConnectionName !== input.targetConnectionName) {
                inputs ??= block.inputs.slice();
                inputs[index] = { ...input, targetBlockId: resolvedBlockId, targetConnectionName: resolvedConnectionName };
            }
            const childDomain = block.className === "SystemBlock" ? (input.name === "particle" ? PARTICLE_DOMAIN : SYSTEM_DOMAIN) : domain;
            visitBlock(resolvedBlockId, childDomain);
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
            (blocks ??= new Map(graph.blocks)).set(block.id, { ...block, inputs });
        }
    };

    for (const systemId of graph.systemBlockIds) {
        visitBlock(systemId, SYSTEM_DOMAIN);
    }
    if (!blocks) {
        return { blocks: graph.blocks, systemBlockIds: graph.systemBlockIds, _isGraphPlumbingNormalized: true };
    }
    return { blocks, systemBlockIds: graph.systemBlockIds, _isGraphPlumbingNormalized: true };
}
