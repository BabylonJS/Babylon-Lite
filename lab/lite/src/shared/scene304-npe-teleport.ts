import { SCENE262_NPE_JSON } from "./scene262-npe.js";

interface Scene304Input {
    name?: string;
    targetBlockId?: number;
    targetConnectionName?: string;
    [key: string]: unknown;
}

interface Scene304Block {
    customType?: string;
    id: number;
    name?: string;
    inputs: Scene304Input[];
    [key: string]: unknown;
}

interface Scene304Graph {
    blocks: Scene304Block[];
    [key: string]: unknown;
}

interface Scene304Consumer {
    readonly blockId: number;
    readonly inputName: string;
}

function addTeleportFanOut(graph: Scene304Graph, sourceBlockId: number, sourceConnectionName: string, consumers: readonly Scene304Consumer[], nextId: { value: number }): void {
    const entryPointId = nextId.value++;
    graph.blocks.push({
        customType: "BABYLON.ParticleTeleportInBlock",
        id: entryPointId,
        name: `Teleport ${sourceBlockId}`,
        inputs: [{ name: "input", inputName: "input", targetBlockId: sourceBlockId, targetConnectionName: sourceConnectionName }],
        outputs: [],
    });

    for (const consumer of consumers) {
        const endpointId = nextId.value++;
        graph.blocks.push({
            customType: "BABYLON.ParticleTeleportOutBlock",
            id: endpointId,
            name: `> Teleport ${sourceBlockId}`,
            entryPoint: entryPointId,
            inputs: [],
            outputs: [{ name: "output" }],
        });
        const block = graph.blocks.find((candidate) => candidate.id === consumer.blockId)!;
        const input = block.inputs.find((candidate) => candidate.name === consumer.inputName)!;
        input.targetBlockId = endpointId;
        input.targetConnectionName = "output";
    }
}

/** Scene 262 with deterministic value fan-out and particle flow routed through Teleport blocks. */
export function createScene304NpeGraph(): object {
    const graph = structuredClone(SCENE262_NPE_JSON) as unknown as Scene304Graph;
    const nextId = { value: 1000 };

    addTeleportFanOut(
        graph,
        18,
        "output",
        [
            { blockId: 17, inputName: "min" },
            { blockId: 17, inputName: "max" },
        ],
        nextId
    );
    addTeleportFanOut(
        graph,
        15,
        "output",
        [
            { blockId: 14, inputName: "min" },
            { blockId: 14, inputName: "max" },
        ],
        nextId
    );
    addTeleportFanOut(
        graph,
        28,
        "output",
        [
            { blockId: 27, inputName: "direction1" },
            { blockId: 27, inputName: "direction2" },
        ],
        nextId
    );
    addTeleportFanOut(graph, 40, "output", [{ blockId: 44, inputName: "particle" }], nextId);

    return graph;
}
