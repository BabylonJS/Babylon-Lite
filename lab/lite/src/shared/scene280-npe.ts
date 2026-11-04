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
    capacity?: number;
    value?: number | number[];
    [key: string]: unknown;
}

function setBlockValue(blocks: MutableBlock[], name: string, value: number | number[]): void {
    blocks.find((block) => block.name === name)!.value = value;
}

/**
 * Scene 280 - NPE UpdateFlowMapBlock graph derived from the canonical scene 262 particle graph.
 * The value edits depend on scene 262's block names; update them if that serialized fixture is regenerated.
 * The flow setup mirrors Babylon.js visual test "Particles - Flowmaps" (#39BW3H#0) with the asymmetric
 * repel-spots map used by playground #PPC2EI#7.
 */
export function createScene280NpeJson(): unknown {
    const graph = structuredClone(SCENE262_NPE_JSON) as unknown as { blocks: MutableBlock[] };
    const system = graph.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
    const particle = system.inputs.find((input) => input.name === "particle")!;
    const emitRate = system.inputs.find((input) => input.name === "emitRate")!;
    const previousBlockId = particle.targetBlockId!;
    const previousConnectionName = particle.targetConnectionName!;
    const flowMapId = Math.max(...graph.blocks.map((block) => block.id)) + 1;
    const flowTextureId = flowMapId + 1;

    graph.blocks.push(
        {
            customType: "BABYLON.UpdateFlowMapBlock",
            id: flowMapId,
            name: "Flow Map Update",
            visibleOnFrame: false,
            inputs: [
                {
                    name: "particle",
                    inputName: "particle",
                    targetBlockId: previousBlockId,
                    targetConnectionName: previousConnectionName,
                },
                {
                    name: "flowMap",
                    inputName: "flowMap",
                    targetBlockId: flowTextureId,
                    targetConnectionName: "texture",
                },
                {
                    name: "strength",
                    valueType: "number",
                    value: 15,
                },
            ],
            outputs: [{ name: "output" }],
        },
        {
            customType: "BABYLON.ParticleTextureSourceBlock",
            id: flowTextureId,
            name: "Flow Map Texture",
            visibleOnFrame: false,
            inputs: [],
            outputs: [{ name: "texture" }],
            url: "https://assets.babylonjs.com/textures/particleFlowMap_repelSpots.png",
            serializedCachedData: false,
            invertY: true,
        }
    );

    particle.targetBlockId = flowMapId;
    particle.targetConnectionName = "output";
    emitRate.value = 20;
    system.capacity = 128;
    setBlockValue(graph.blocks, "Min Emit Power", 1);
    setBlockValue(graph.blocks, "Max Emit Power", 1);
    setBlockValue(graph.blocks, "Min Lifetime", 6);
    setBlockValue(graph.blocks, "Max Lifetime", 6);
    setBlockValue(graph.blocks, "Min size", 0.6);
    setBlockValue(graph.blocks, "Max size", 0.6);
    setBlockValue(graph.blocks, "Direction 1", [1, 0, 0]);
    setBlockValue(graph.blocks, "Direction 2", [1, 0, 0]);
    setBlockValue(graph.blocks, "Min Emit Box", [-7, -0.1, 0]);
    setBlockValue(graph.blocks, "Max Emit Box", [-7, 0.1, 0]);
    return graph;
}
