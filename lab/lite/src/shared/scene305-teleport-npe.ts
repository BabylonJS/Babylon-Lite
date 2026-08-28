import { SCENE262_NPE_JSON } from "./scene262-npe.js";

interface Scene305Input {
    name?: string;
    targetBlockId?: number;
    targetConnectionName?: string;
    [key: string]: unknown;
}

interface Scene305Block {
    customType?: string;
    id: number;
    name?: string;
    inputs: Scene305Input[];
    [key: string]: unknown;
}

interface Scene305Graph {
    blocks: Scene305Block[];
    [key: string]: unknown;
}

interface Scene305Consumer {
    readonly blockId: number;
    readonly inputName: string;
}

function addPhase3CValueRoute(graph: Scene305Graph, nextId: { value: number }): void {
    const elbowId = nextId.value++;
    const debugId = nextId.value++;
    const localId = nextId.value++;
    graph.blocks.push(
        {
            customType: "BABYLON.ParticleElbowBlock",
            id: elbowId,
            name: "Size elbow",
            inputs: [{ name: "input", targetBlockId: 11, targetConnectionName: "output" }],
            outputs: [{ name: "output" }],
        },
        {
            customType: "BABYLON.ParticleDebugBlock",
            id: debugId,
            name: "Size debug",
            stackSize: 37,
            inputs: [{ name: "input", targetBlockId: elbowId, targetConnectionName: "output" }],
            outputs: [{ name: "output" }],
        },
        {
            customType: "BABYLON.ParticleLocalVariableBlock",
            id: localId,
            name: "Particle size snapshot",
            scope: 0,
            inputs: [{ name: "input", targetBlockId: debugId, targetConnectionName: "output" }],
            outputs: [{ name: "output" }],
        }
    );
    const createBlock = graph.blocks.find((block) => block.id === 4)!;
    const sizeInput = createBlock.inputs.find((input) => input.name === "size")!;
    sizeInput.targetBlockId = localId;
    sizeInput.targetConnectionName = "output";
}

function addTeleportFanOut(graph: Scene305Graph, sourceBlockId: number, sourceConnectionName: string, consumers: readonly Scene305Consumer[], nextId: { value: number }): void {
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

/** Scene 262 with deterministic value/local-variable plumbing and particle flow routed through Teleport blocks. */
export function createScene305NpeGraph(): object {
    const graph = structuredClone(SCENE262_NPE_JSON) as unknown as Scene305Graph;
    const nextId = { value: 1000 };

    addPhase3CValueRoute(graph, nextId);

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
