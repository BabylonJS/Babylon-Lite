// Scene 84 — NME fragment/screen coordinate blocks.
// A shared deterministic graph is parsed by both Babylon.js and Babylon Lite. It uses:
// FragCoordBlock + ScreenSizeBlock => normalized screen UV, TwirlBlock for a visible swirl,
// ScreenSpaceBlock for projected mesh coordinates, and FragDepthBlock to let a later
// background plane overwrite the right side where the custom depth is farther away.

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
    if (type === TYPE_VECTOR4) {
        return "BABYLON.Vector4";
    }
    return "BABYLON.Matrix";
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

function transform(name: string, vector: number, matrix: number, complementW: 0 | 1): number {
    return addBlock("TransformBlock", name, TARGET_VERTEX, [input("vector", { id: vector, output: "output" }), input("transform", { id: matrix, output: "output" })], [output("output"), output("xyz")], {
        complementZ: 0,
        complementW,
    });
}

function divide(name: string, left: number, leftOutput: string, right: number, rightOutput: string): number {
    return addBlock("DivideBlock", name, TARGET_NEUTRAL, [input("left", { id: left, output: leftOutput }), input("right", { id: right, output: rightOutput })], [output("output")]);
}

function split(name: string, source: number, sourceOutput: string): number {
    return addBlock("VectorSplitterBlock", name, TARGET_NEUTRAL, [input("xy ", { id: source, output: sourceOutput })], [output("xyz"), output("xy"), output("zw"), output("x"), output("y"), output("z"), output("w")]);
}

function color(name: string, r: number, rOut: string, g: number, gOut: string, b: number, bOut: string): number {
    return addBlock(
        "ColorMergerBlock",
        name,
        TARGET_NEUTRAL,
        [input("rgb "), input("r", { id: r, output: rOut }), input("g", { id: g, output: gOut }), input("b", { id: b, output: bOut }), input("a")],
        [output("rgba"), output("rgb")],
        { rSwizzle: "r", gSwizzle: "g", bSwizzle: "b", aSwizzle: "a" }
    );
}

const position = inputBlock("position", TYPE_VECTOR3, null, 1);
const wvpVertex = inputBlock("worldViewProjection", TYPE_MATRIX, null, 0, 6, TARGET_VERTEX);
const wvpFragment = inputBlock("worldViewProjection", TYPE_MATRIX, null, 0, 6, TARGET_FRAGMENT);
const clipPos = transform("TransformWVP", position, wvpVertex, 1);
const vertexOutput = addBlock("VertexOutputBlock", "VertexOutput", TARGET_VERTEX, [input("vector", { id: clipPos, output: "output" })], []);

const fragCoord = addBlock("FragCoordBlock", "FragCoord", TARGET_FRAGMENT, [], [output("xy"), output("xyz"), output("xyzw"), output("x"), output("y"), output("z"), output("w")]);
const screenSize = addBlock("ScreenSizeBlock", "ScreenSize", TARGET_FRAGMENT, [], [output("xy"), output("x"), output("y")]);
const screenUv = divide("ScreenUV", fragCoord, "xy", screenSize, "xy");
const screenUvSplit = split("SplitScreenUV", screenUv, "output");
const twirlStrength = inputBlock("twirlStrength", TYPE_FLOAT, 8.5);
const twirlCenter = inputBlock("twirlCenter", TYPE_VECTOR2, [0.5, 0.5]);
const twirlOffset = inputBlock("twirlOffset", TYPE_VECTOR2, [0, 0]);
const twirl = addBlock(
    "TwirlBlock",
    "Twirl",
    TARGET_FRAGMENT,
    [input("input", { id: screenUv, output: "output" }), input("strength", { id: twirlStrength, output: "output" }), input("center", { id: twirlCenter, output: "output" }), input("offset", { id: twirlOffset, output: "output" })],
    [output("output"), output("x"), output("y")]
);
const screenSpace = addBlock(
    "ScreenSpaceBlock",
    "ScreenSpace",
    TARGET_FRAGMENT,
    [input("vector", { id: position, output: "output" }), input("worldViewProjection", { id: wvpFragment, output: "output" })],
    [output("output"), output("x"), output("y")]
);
const rgb = color("FragmentColor", twirl, "x", screenSpace, "y", fragCoord, "z");
const fragmentOutput = addBlock("FragmentOutputBlock", "FragmentOutput", TARGET_FRAGMENT, [input("rgba"), input("rgb", { id: rgb, output: "rgb" }), input("a")], []);
const fragDepth = addBlock("FragDepthBlock", "FragDepth", TARGET_FRAGMENT, [input("depth", { id: screenUvSplit, output: "x" }), input("worldPos"), input("viewProjection")], []);

export const SCENE84_NME_JSON = {
    forceAlphaBlending: false,
    id: "scene84nm",
    name: "Scene84NMEFragmentScreen",
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
    outputNodes: [vertexOutput, fragmentOutput, fragDepth],
};
