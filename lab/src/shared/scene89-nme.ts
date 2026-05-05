// Scene 89 — NME StorageReadBlock / StorageWriteBlock.
// A deterministic low-iteration loop updates a vec4 storage value. Each iteration
// reads the current storage, derives component-dependent scalar updates, writes
// the next vec4, then the final storage value is emitted as the fragment color.

type NmeInput = {
    name: string;
    inputName: string;
    displayName: string;
    targetBlockId?: number;
    targetConnectionName?: string;
    isExposedOnFrame: boolean;
    exposedPortPosition: number;
};

type NmeOutput = { name: string };

type NmeBlock = {
    customType: string;
    id: number;
    name: string;
    comments: string;
    target: number;
    inputs: NmeInput[];
    outputs: NmeOutput[];
    [key: string]: unknown;
};

type NmeValue = number | number[];

const TARGET_VERTEX = 1;
const TARGET_FRAGMENT = 2;
const TARGET_NEUTRAL = 4;

const TYPE_FLOAT = 1;
const TYPE_VECTOR2 = 4;
const TYPE_VECTOR3 = 8;
const TYPE_VECTOR4 = 16;
const TYPE_MATRIX = 128;

let nextId = 1;
const blocks: NmeBlock[] = [];

function output(name: string): NmeOutput {
    return { name };
}

function input(name: string, source?: { id: number; output: string }): NmeInput {
    return {
        name,
        inputName: name,
        displayName: name.trim(),
        ...(source ? { targetBlockId: source.id, targetConnectionName: source.output } : {}),
        isExposedOnFrame: true,
        exposedPortPosition: -1,
    };
}

function addBlock(className: string, name: string, target: number, inputs: NmeInput[], outputs: NmeOutput[], extra: Record<string, unknown> = {}): number {
    const id = nextId++;
    blocks.push({
        customType: `BABYLON.${className}`,
        id,
        name,
        comments: "",
        target,
        inputs,
        outputs,
        ...extra,
    });
    return id;
}

function valueType(type: number): string {
    if (type === TYPE_FLOAT) {
        return "number";
    }
    if (type === TYPE_VECTOR2) {
        return "BABYLON.Vector2";
    }
    if (type === TYPE_VECTOR3) {
        return "BABYLON.Vector3";
    }
    return "BABYLON.Vector4";
}

function inputBlock(name: string, type: number, value: NmeValue | null, mode = 0, systemValue: number | null = null, target = mode === 1 ? TARGET_VERTEX : TARGET_NEUTRAL): number {
    const extra: Record<string, unknown> = {
        type,
        mode,
        systemValue,
        animationType: 0,
        min: 0,
        max: 0,
        isBoolean: false,
        matrixMode: 0,
        isConstant: false,
        groupInInspector: "",
        convertToGammaSpace: false,
        convertToLinearSpace: false,
    };
    if (value !== null) {
        extra.valueType = valueType(type);
        extra.value = value;
    }
    return addBlock("InputBlock", name, target, [], [output("output")], extra);
}

function binary(className: string, name: string, left: { id: number; output: string }, right: { id: number; output: string }): number {
    return addBlock(className, name, TARGET_NEUTRAL, [input("left", left), input("right", right)], [output("output")]);
}

function multiply(name: string, left: { id: number; output: string }, right: { id: number; output: string }): number {
    return binary("MultiplyBlock", name, left, right);
}

function add(name: string, left: { id: number; output: string }, right: { id: number; output: string }): number {
    return binary("AddBlock", name, left, right);
}

function subtract(name: string, left: { id: number; output: string }, right: { id: number; output: string }): number {
    return binary("SubtractBlock", name, left, right);
}

function divide(name: string, left: { id: number; output: string }, right: { id: number; output: string }): number {
    return binary("DivideBlock", name, left, right);
}

const position = inputBlock("position", TYPE_VECTOR3, null, 1);
const wvp = inputBlock("worldViewProjection", TYPE_MATRIX, null, 0, 6, TARGET_VERTEX);
const transform = addBlock(
    "TransformBlock",
    "Transform",
    TARGET_VERTEX,
    [input("vector", { id: position, output: "output" }), input("transform", { id: wvp, output: "output" })],
    [output("output"), output("xyz")],
    {
        complementZ: 0,
        complementW: 1,
    }
);
const vertexOutput = addBlock("VertexOutputBlock", "VertexOutput", TARGET_VERTEX, [input("vector", { id: transform, output: "output" })], []);

const uv = inputBlock("uv", TYPE_VECTOR2, null, 1);
const uvSplit = addBlock(
    "VectorSplitterBlock",
    "SplitUV",
    TARGET_NEUTRAL,
    [input("xy ", { id: uv, output: "output" })],
    [output("xyz"), output("xy"), output("zw"), output("x"), output("y"), output("z"), output("w")]
);

const initialStorage = inputBlock("initialStorage", TYPE_VECTOR4, [0.035, 0.045, 0.055, 1]);
const loop = addBlock(
    "LoopBlock",
    "StorageFeedbackLoop",
    TARGET_NEUTRAL,
    [input("input", { id: initialStorage, output: "output" }), input("iterations")],
    [output("output"), output("index"), output("loopID")],
    {
        iterations: 6,
    }
);
const read = addBlock("StorageReadBlock", "ReadLoopStorage", TARGET_NEUTRAL, [input("loopID", { id: loop, output: "loopID" })], [output("value")]);
const readSplit = addBlock(
    "VectorSplitterBlock",
    "SplitLoopStorage",
    TARGET_NEUTRAL,
    [input("xyzw", { id: read, output: "value" })],
    [output("xyzw"), output("xyz"), output("xy"), output("x"), output("y"), output("z"), output("w")]
);

const six = inputBlock("loopCount", TYPE_FLOAT, 6);
const one = inputBlock("one", TYPE_FLOAT, 1);
const rBase = inputBlock("rBase", TYPE_FLOAT, 0.025);
const rSlope = inputBlock("rSlope", TYPE_FLOAT, 0.055);
const gBase = inputBlock("gBase", TYPE_FLOAT, 0.02);
const gSlope = inputBlock("gSlope", TYPE_FLOAT, 0.045);
const bBase = inputBlock("bBase", TYPE_FLOAT, 0.012);
const bSlope = inputBlock("bSlope", TYPE_FLOAT, 0.02);
const bFeedbackScale = inputBlock("bFeedbackScale", TYPE_FLOAT, 0.08);

const indexPlusOne = add("IndexPlusOne", { id: loop, output: "index" }, { id: one, output: "output" });
const indexNorm = divide("IndexNorm", { id: indexPlusOne, output: "output" }, { id: six, output: "output" });
const mask = addBlock(
    "StepBlock",
    "StorageBandMask",
    TARGET_NEUTRAL,
    [input("value", { id: uvSplit, output: "x" }), input("edge", { id: indexNorm, output: "output" })],
    [output("output")]
);
const invIndexNorm = subtract("OneMinusIndexNorm", { id: one, output: "output" }, { id: indexNorm, output: "output" });

const rWeight = add("RWeight", { id: rBase, output: "output" }, { id: multiply("RWeightSlope", { id: indexNorm, output: "output" }, { id: rSlope, output: "output" }), output: "output" });
const gWeight = add("GWeight", { id: gBase, output: "output" }, { id: multiply("GWeightSlope", { id: invIndexNorm, output: "output" }, { id: gSlope, output: "output" }), output: "output" });
const bSeed = add("BSeed", { id: bBase, output: "output" }, { id: multiply("BSeedSlope", { id: indexNorm, output: "output" }, { id: bSlope, output: "output" }), output: "output" });
const bFeedback = multiply("BFeedback", { id: readSplit, output: "x" }, { id: bFeedbackScale, output: "output" });
const bWeight = add("BWeight", { id: bSeed, output: "output" }, { id: bFeedback, output: "output" });

const rContribution = multiply("RContribution", { id: mask, output: "output" }, { id: rWeight, output: "output" });
const maskedGWeight = multiply("MaskedGWeight", { id: mask, output: "output" }, { id: gWeight, output: "output" });
const gContribution = multiply("GContribution", { id: maskedGWeight, output: "output" }, { id: uvSplit, output: "y" });
const bContribution = multiply("BContribution", { id: mask, output: "output" }, { id: bWeight, output: "output" });

const nextR = add("NextR", { id: readSplit, output: "x" }, { id: rContribution, output: "output" });
const nextG = add("NextG", { id: readSplit, output: "y" }, { id: gContribution, output: "output" });
const nextB = add("NextB", { id: readSplit, output: "z" }, { id: bContribution, output: "output" });
const nextStorage = addBlock(
    "VectorMergerBlock",
    "NextLoopStorage",
    TARGET_NEUTRAL,
    [
        input("xyzIn"),
        input("xyIn"),
        input("zwIn"),
        input("x", { id: nextR, output: "output" }),
        input("y", { id: nextG, output: "output" }),
        input("z", { id: nextB, output: "output" }),
        input("w", { id: readSplit, output: "w" }),
    ],
    [output("xyzw"), output("xyz"), output("xy")]
);
addBlock("StorageWriteBlock", "WriteLoopStorage", TARGET_NEUTRAL, [input("loopID", { id: loop, output: "loopID" }), input("value", { id: nextStorage, output: "xyzw" })], []);

const fragmentOutput = addBlock("FragmentOutputBlock", "FragmentOutput", TARGET_FRAGMENT, [input("rgba", { id: loop, output: "output" }), input("rgb"), input("a")], [], {
    convertToGammaSpace: false,
    convertToLinearSpace: false,
    useLogarithmicDepth: false,
});

export const SCENE89_NME_JSON = {
    tags: null,
    ignoreAlpha: false,
    maxSimultaneousLights: 4,
    mode: 0,
    forceAlphaBlending: false,
    id: "scene89nm",
    name: "Scene89NMEStorage",
    customType: "BABYLON.NodeMaterial",
    checkReadyOnEveryCall: false,
    checkReadyOnlyOnce: false,
    state: "",
    alpha: 1,
    backFaceCulling: true,
    sideOrientation: 1,
    alphaMode: 2,
    _needAlphaBlending: false,
    _needAlphaTesting: false,
    forceDepthWrite: false,
    separateCullingPass: false,
    fogEnabled: false,
    pointSize: 1,
    zOffset: 0,
    zOffsetUnits: 0,
    pointsCloud: false,
    fillMode: 0,
    editorData: null,
    customBlocks: [],
    blocks,
    outputNodes: [vertexOutput, fragmentOutput],
};
