import type { ParticleGraph, ParsedParticleBlock, ParsedParticleInput } from "./npe-types.js";

interface RawInput {
    name?: string;
    targetBlockId?: number;
    targetConnectionName?: string;
    value?: unknown;
    valueType?: string;
}

interface RawBlock {
    customType?: string;
    id?: number;
    name?: string;
    inputs?: RawInput[];
    [key: string]: unknown;
}

/** Strip the `BABYLON.` prefix from a serialized `customType`. */
function stripBabylonPrefix(customType: string | undefined): string {
    if (!customType) {
        return "";
    }
    return customType.startsWith("BABYLON.") ? customType.slice("BABYLON.".length) : customType;
}

/**
 * Parse a node-particle graph source object (the inner `nodeParticle` payload) into a {@link ParticleGraph}.
 *
 * The serialized shape mirrors Babylon.js `NodeParticleSystemSet.serialize`: a flat `blocks` array where
 * each block carries `customType`, `id`, `name`, and an `inputs` array whose entries reference their source
 * via `targetBlockId` + `targetConnectionName`. `SystemBlock` instances are the graph roots.
 */
export function parseNodeParticleSource(source: unknown): ParticleGraph {
    const raw = source as { blocks?: RawBlock[] };
    if (!raw || !Array.isArray(raw.blocks)) {
        throw new Error("NodeParticle: invalid source — expected a `blocks` array");
    }

    const blocks = new Map<number, ParsedParticleBlock>();
    const systemBlockIds: number[] = [];

    for (const rb of raw.blocks) {
        if (typeof rb.id !== "number") {
            throw new Error(`NodeParticle: block missing numeric id (name=${String(rb.name)})`);
        }

        const className = stripBabylonPrefix(rb.customType);

        const inputs: ParsedParticleInput[] = [];
        for (const ri of rb.inputs ?? []) {
            inputs.push({
                name: (ri.name ?? "").trim(),
                targetBlockId: typeof ri.targetBlockId === "number" ? ri.targetBlockId : null,
                targetConnectionName: typeof ri.targetConnectionName === "string" ? ri.targetConnectionName.trim() : null,
                value: ri.value,
                valueType: typeof ri.valueType === "string" ? ri.valueType : undefined,
            });
        }

        blocks.set(rb.id, { id: rb.id, className, name: rb.name ?? "", inputs, serialized: rb as Record<string, unknown> });

        if (className === "SystemBlock") {
            systemBlockIds.push(rb.id);
        }
    }

    if (systemBlockIds.length === 0) {
        throw new Error("NodeParticle: graph has no SystemBlock");
    }

    return { blocks, systemBlockIds };
}
