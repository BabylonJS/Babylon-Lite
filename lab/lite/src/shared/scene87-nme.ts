/** Scene 87 — NME PBR iridescence + ImageProcessingBlock.
 *
 *  Starts from the scene 67 PBR-MR graph, adds an IridescenceBlock wired to the
 *  PBR block, then routes PBR.lighting through ImageProcessingBlock before the
 *  FragmentOutput. The same deterministic JSON is parsed by Babylon.js and Lite.
 */

import { SCENE67_NME_JSON } from "./scene67-nme.js";

function updateBlock(block: (typeof SCENE67_NME_JSON.blocks)[number]): (typeof SCENE67_NME_JSON.blocks)[number] | Record<string, unknown> {
    if (block.id === 6) {
        return { ...block, value: [0.78, 0.62, 0.92] };
    }
    if (block.id === 8) {
        return { ...block, value: 0.28 };
    }
    if (block.id === 13) {
        return {
            ...block,
            inputs: [
                ...block.inputs,
                { name: "iridescence", inputName: "iridescence", targetBlockId: 19, targetConnectionName: "iridescence" },
            ],
        };
    }
    if (block.id === 14) {
        return {
            ...block,
            inputs: [
                { name: "rgba", inputName: "rgba", targetBlockId: 20, targetConnectionName: "output" },
                { name: "rgb", inputName: "rgb" },
                { name: "a", inputName: "a" },
            ],
        };
    }
    return block;
}

const iriIntensity = {
    customType: "BABYLON.InputBlock",
    id: 16,
    name: "iridescenceIntensity",
    target: 2,
    inputs: [],
    outputs: [{ name: "output" }],
    type: 1,
    mode: 0,
    systemValue: null,
    animationType: 0,
    min: 0,
    max: 1,
    isBoolean: false,
    matrixMode: 0,
    isConstant: false,
    valueType: "number",
    value: 0.95,
    convertToGammaSpace: false,
    convertToLinearSpace: false,
};

const iriIor = {
    ...iriIntensity,
    id: 17,
    name: "iridescenceIor",
    min: 1,
    max: 3,
    value: 1.32,
};

const iriThickness = {
    ...iriIntensity,
    id: 18,
    name: "iridescenceThickness",
    min: 0,
    max: 1200,
    value: 560,
};

export const SCENE87_NME_JSON = {
    ...SCENE67_NME_JSON,
    id: "scene87nm",
    name: "Scene87NME",
    blocks: [
        ...SCENE67_NME_JSON.blocks.map(updateBlock),
        iriIntensity,
        iriIor,
        iriThickness,
        {
            customType: "BABYLON.IridescenceBlock",
            id: 19,
            name: "Iridescence",
            target: 2,
            inputs: [
                { name: "intensity", inputName: "intensity", targetBlockId: 16, targetConnectionName: "output" },
                { name: "indexOfRefraction", inputName: "indexOfRefraction", targetBlockId: 17, targetConnectionName: "output" },
                { name: "thickness", inputName: "thickness", targetBlockId: 18, targetConnectionName: "output" },
            ],
            outputs: [{ name: "iridescence" }],
        },
        {
            customType: "BABYLON.ImageProcessingBlock",
            id: 20,
            name: "ImageProcessing",
            target: 2,
            inputs: [{ name: "color", inputName: "color", targetBlockId: 13, targetConnectionName: "lighting" }],
            outputs: [{ name: "output" }, { name: "rgb" }],
            convertInputToLinearSpace: false,
        },
    ],
    outputNodes: [12, 14],
};
