// Scene 79 — NME conditions, curves, waves, NLerp, and deterministic random.

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
        extra.valueType = type === TYPE_FLOAT ? "number" : type === TYPE_VECTOR2 ? "BABYLON.Vector2" : type === TYPE_VECTOR3 ? "BABYLON.Vector3" : "BABYLON.Vector4";
        extra.value = value;
    }
    return addBlock("InputBlock", name, target, [], [output("output")], extra);
}

function binary(className: string, name: string, left: number, right: number, leftOutput = "output", rightOutput = "output"): number {
    return addBlock(className, name, TARGET_NEUTRAL, [input("left", { id: left, output: leftOutput }), input("right", { id: right, output: rightOutput })], [output("output")]);
}

function split(name: string, source: number, sourceOutput: string, inputName: "xy" | "xyz"): number {
    return addBlock("VectorSplitterBlock", name, TARGET_NEUTRAL, [input(`${inputName} `, { id: source, output: sourceOutput })], [output("xyz"), output("xy"), output("zw"), output("x"), output("y"), output("z"), output("w")]);
}

function merge3(name: string, x: number, y: number, z: number, xOutput = "output", yOutput = "output", zOutput = "output"): number {
    return addBlock(
        "VectorMergerBlock",
        name,
        TARGET_NEUTRAL,
        [input("xyzw "), input("xyz "), input("xy "), input("zw "), input("x", { id: x, output: xOutput }), input("y", { id: y, output: yOutput }), input("z", { id: z, output: zOutput }), input("w")],
        [output("xyzw"), output("xyz"), output("xy")]
    );
}

function conditional(name: string, condition: number, a: number, b: number, trueValue: number, falseValue: number, aOutput = "output", bOutput = "output", trueOutput = "output", falseOutput = "output"): number {
    return addBlock(
        "ConditionalBlock",
        name,
        TARGET_NEUTRAL,
        [input("a", { id: a, output: aOutput }), input("b", { id: b, output: bOutput }), input("true", { id: trueValue, output: trueOutput }), input("false", { id: falseValue, output: falseOutput })],
        [output("output")],
        { condition }
    );
}

function curve(name: string, curveType: number, source: number, sourceOutput = "output"): number {
    return addBlock("CurveBlock", name, TARGET_NEUTRAL, [input("input", { id: source, output: sourceOutput })], [output("output")], { curveType });
}

function wave(name: string, kind: number, source: number, sourceOutput = "output"): number {
    return addBlock("WaveBlock", name, TARGET_NEUTRAL, [input("input", { id: source, output: sourceOutput })], [output("output")], { kind });
}

const position = inputBlock("position", TYPE_VECTOR3, null, 1);
const wvp = inputBlock("worldViewProjection", TYPE_MATRIX, null, 0, 6, TARGET_VERTEX);
const transform = addBlock("TransformBlock", "Transform", TARGET_VERTEX, [input("vector", { id: position, output: "output" }), input("transform", { id: wvp, output: "output" })], [output("output"), output("xyz")], { complementZ: 0, complementW: 1 });
const vertexOutput = addBlock("VertexOutputBlock", "VertexOutput", TARGET_VERTEX, [input("vector", { id: transform, output: "output" })], []);

const uv = inputBlock("uv", TYPE_VECTOR2, null, 1);
const uvSplit = split("SplitUV", uv, "output", "xy");

const zero = inputBlock("zero", TYPE_FLOAT, 0);
const tenth = inputBlock("tenth", TYPE_FLOAT, 0.1);
const quarter = inputBlock("quarter", TYPE_FLOAT, 0.25);
const third = inputBlock("third", TYPE_FLOAT, 0.3333333333333333);
const half = inputBlock("half", TYPE_FLOAT, 0.5);
const twoThirds = inputBlock("twoThirds", TYPE_FLOAT, 0.6666666666666666);
const nineTenths = inputBlock("nineTenths", TYPE_FLOAT, 0.9);
const one = inputBlock("one", TYPE_FLOAT, 1);
const three = inputBlock("three", TYPE_FLOAT, 3);
const four = inputBlock("four", TYPE_FLOAT, 4);

const nlerpLeft = inputBlock("nlerpLeft", TYPE_VECTOR3, [1, 0.15, 0.05]);
const nlerpRight = inputBlock("nlerpRight", TYPE_VECTOR3, [0.05, 0.2, 1]);
const nlerp = addBlock("NLerpBlock", "NLerpGradient", TARGET_NEUTRAL, [input("left", { id: nlerpLeft, output: "output" }), input("right", { id: nlerpRight, output: "output" }), input("gradient", { id: uvSplit, output: "x" })], [output("output")]);
const nlerpSplit = split("SplitNLerp", nlerp, "output", "xyz");
const condLess = conditional("CondLessThanStripe", 2, uvSplit, third, tenth, nineTenths, "x");
const condGreaterX = conditional("CondGreaterX", 3, uvSplit, half, one, zero, "x");
const condGreaterY = conditional("CondGreaterY", 3, uvSplit, half, one, zero, "y");
const condAnd = conditional("CondAndQuadrants", 8, condGreaterX, condGreaterY, one, quarter);
const rSumA = binary("AddBlock", "RAddNLerpLess", nlerpSplit, condLess, "x");
const rSumB = binary("AddBlock", "RAddAnd", rSumA, condAnd);
const red = binary("DivideBlock", "RedAverage", rSumB, three);

const curveInOutSine = curve("CurveEaseInOutSineX", 2, uvSplit, "x");
const curveInQuad = curve("CurveEaseInQuadY", 3, uvSplit, "y");
const curveInBack = curve("CurveEaseInBackX", 21, uvSplit, "x");
const condLe = conditional("CondCurveLessOrEqual", 4, uvSplit, twoThirds, curveInQuad, curveInBack, "x");
const gSumA = binary("AddBlock", "GAddSineConditional", curveInOutSine, condLe);
const gSumB = binary("AddBlock", "GAddQuad", gSumA, curveInQuad);
const green = binary("DivideBlock", "GreenAverage", gSumB, three);

const xTimesFour = binary("MultiplyBlock", "XTimesFour", uvSplit, four, "x");
const yTimesFour = binary("MultiplyBlock", "YTimesFour", uvSplit, four, "y");
const xPlusY = binary("AddBlock", "XPlusY", uvSplit, uvSplit, "x", "y");
const diagonalTimesThree = binary("MultiplyBlock", "DiagonalTimesThree", xPlusY, three);
const saw = wave("WaveSawX", 0, xTimesFour);
const square = wave("WaveSquareY", 1, yTimesFour);
const triangle = wave("WaveTriangleDiag", 2, diagonalTimesThree);
const sawMapped = binary("AddBlock", "SawMap", binary("MultiplyBlock", "SawHalf", saw, half), half);
const squareMapped = binary("AddBlock", "SquareMap", binary("MultiplyBlock", "SquareHalf", square, half), half);
const triangleMapped = binary("AddBlock", "TriangleMap", binary("MultiplyBlock", "TriangleHalf", triangle, half), half);
const random = addBlock("RandomNumberBlock", "RandomFromUV", TARGET_NEUTRAL, [input("seed", { id: uv, output: "output" })], [output("output")]);
const bSumA = binary("AddBlock", "BAddSawSquare", sawMapped, squareMapped);
const bSumB = binary("AddBlock", "BAddTriangle", bSumA, triangleMapped);
const bSumC = binary("AddBlock", "BAddRandom", bSumB, random);
const blue = binary("DivideBlock", "BlueAverage", bSumC, four);

const color = merge3("MergeModesColor", red, green, blue);
const fragmentOutput = addBlock("FragmentOutputBlock", "FragmentOutput", TARGET_FRAGMENT, [input("rgba"), input("rgb", { id: color, output: "xyz" }), input("a")], [], {
    convertToGammaSpace: false,
    convertToLinearSpace: false,
    useLogarithmicDepth: false,
});

export const SCENE79_NME_JSON = {
    tags: null,
    ignoreAlpha: false,
    maxSimultaneousLights: 4,
    mode: 0,
    forceAlphaBlending: false,
    id: "scene79nm",
    name: "Scene79NMEModes",
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
