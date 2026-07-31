import { SCENE262_NPE_JSON } from "./scene262-npe.js";

interface MutableInput {
    name: string;
    inputName?: string;
    targetBlockId?: number;
    targetConnectionName?: string;
    valueType?: string;
    value?: number | number[];
}

interface MutableBlock {
    customType: string;
    id: number;
    name: string;
    inputs: MutableInput[];
    outputs?: Array<{ name: string }>;
    [key: string]: unknown;
}

/** Scene 277 - NPE UpdateAttractorBlock graph derived from the canonical scene 262 particle graph. */
export function createScene277NpeJson(): unknown {
    const graph = structuredClone(SCENE262_NPE_JSON) as unknown as { blocks: MutableBlock[] };
    const system = graph.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
    const particle = system.inputs.find((input) => input.name === "particle")!;
    const emitRate = system.inputs.find((input) => input.name === "emitRate")!;
    const previousBlockId = particle.targetBlockId!;
    const previousConnectionName = particle.targetConnectionName!;
    const attractorId = Math.max(...graph.blocks.map((block) => block.id)) + 1;

    graph.blocks.push({
        customType: "BABYLON.UpdateAttractorBlock",
        id: attractorId,
        name: "Attractor",
        visibleOnFrame: false,
        inputs: [
            {
                name: "particle",
                inputName: "particle",
                targetBlockId: previousBlockId,
                targetConnectionName: previousConnectionName,
            },
            {
                name: "attractor",
                valueType: "BABYLON.Vector3",
                value: [0, 2, 0],
            },
            {
                name: "strength",
                valueType: "number",
                value: 8,
            },
        ],
        outputs: [{ name: "output" }],
    });
    particle.targetBlockId = attractorId;
    particle.targetConnectionName = "output";
    emitRate.value = 100;
    return graph;
}
