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

const NOISE_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAA7UlEQVR4AQXBscqCUACA0S9dopykRVwEp5aGwMF3aGvQZ2gRFBtF2i8tLb2HD1DocNcQCeKOgQgibi3l/58z22w2f+fzmbqueb/fPB4PhBAMw8DtdkMLwxApJWma4rouQRBwuVywLIvn84m+Xq/zqqpQStH3PZ7n4fs+2+2WKIrQTqcT0zQhpSSOYwzDYL/fs9vtGMcRvW3b3LZtvt8v9/sdx3EQQnC9XlFKoR0OB5IkwTRNPp8PSilerxdZllHXNfpiscjDMMSyLH6/H0opuq7jeDzSNA36arXKi6JgmiYMw2C5XCKlpCxL5vM5/+pQa+mWaBAFAAAAAElFTkSuQmCC";

function setBlockValue(blocks: MutableBlock[], name: string, value: number | number[]): void {
    blocks.find((block) => block.name === name)!.value = value;
}

/** Scene 281 - NPE UpdateNoiseBlock with a portable cached texture payload. */
export function createScene281NpeJson(): unknown {
    const graph = structuredClone(SCENE262_NPE_JSON) as unknown as { blocks: MutableBlock[] };
    const system = graph.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
    const particle = system.inputs.find((input) => input.name === "particle")!;
    const emitRate = system.inputs.find((input) => input.name === "emitRate")!;
    const previousBlockId = particle.targetBlockId!;
    const previousConnectionName = particle.targetConnectionName!;
    const noiseId = Math.max(...graph.blocks.map((block) => block.id)) + 1;
    const noiseTextureId = noiseId + 1;
    const strengthId = noiseId + 2;

    graph.blocks.push(
        {
            customType: "BABYLON.UpdateNoiseBlock",
            id: noiseId,
            name: "Noise Update",
            visibleOnFrame: false,
            inputs: [
                {
                    name: "particle",
                    inputName: "particle",
                    targetBlockId: previousBlockId,
                    targetConnectionName: previousConnectionName,
                },
                {
                    name: "noiseTexture",
                    inputName: "noiseTexture",
                    targetBlockId: noiseTextureId,
                    targetConnectionName: "texture",
                },
                {
                    name: "strength",
                    inputName: "strength",
                    targetBlockId: strengthId,
                    targetConnectionName: "output",
                },
            ],
            outputs: [{ name: "output" }],
        },
        {
            customType: "BABYLON.ParticleTextureSourceBlock",
            id: noiseTextureId,
            name: "Noise Texture",
            visibleOnFrame: false,
            inputs: [],
            outputs: [{ name: "texture" }],
            url: "",
            textureDataUrl: NOISE_DATA_URL,
            serializedCachedData: true,
            invertY: false,
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: strengthId,
            name: "Noise Strength",
            visibleOnFrame: false,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 8,
            valueType: "BABYLON.Vector3",
            value: [1.5, 0.5, 1.5],
            contextualValue: 0,
            systemSource: 0,
            min: 0,
            max: 0,
            groupInInspector: "",
            displayInInspector: true,
        }
    );

    particle.targetBlockId = noiseId;
    particle.targetConnectionName = "output";
    emitRate.value = 30;
    system.capacity = 128;
    setBlockValue(graph.blocks, "Min Emit Power", 1);
    setBlockValue(graph.blocks, "Max Emit Power", 1);
    setBlockValue(graph.blocks, "Min Lifetime", 4);
    setBlockValue(graph.blocks, "Max Lifetime", 4);
    setBlockValue(graph.blocks, "Min size", 0.5);
    setBlockValue(graph.blocks, "Max size", 0.5);
    setBlockValue(graph.blocks, "Direction 1", [0, 2, 0]);
    setBlockValue(graph.blocks, "Direction 2", [0, 2, 0]);
    setBlockValue(graph.blocks, "Min Emit Box", [-0.1, -0.1, -0.1]);
    setBlockValue(graph.blocks, "Max Emit Box", [0.1, 0.1, 0.1]);
    return graph;
}
