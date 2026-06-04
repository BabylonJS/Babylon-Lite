// Scene 85 — NME matrix operations.
// Shared deterministic graph parsed by both Babylon.js and Babylon Lite. It covers:
// MatrixBuilder, MatrixTransposeBlock, MatrixSplitterBlock, MatrixDeterminantBlock,
// plus a readable vertex transform that uses the built matrix before WVP projection.

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

function transform(name: string, vector: number, vectorOutput: string, matrix: number): number {
    return addBlock("TransformBlock", name, TARGET_VERTEX, [input("vector", { id: vector, output: vectorOutput }), input("transform", { id: matrix, output: "output" })], [output("output"), output("xyz")], {
        complementZ: 0,
        complementW: 1,
    });
}

function vector4(name: string, x: number, xOut: string, y: number, yOut: string, z: number, w: number): number {
    const zConst = inputBlock(`${name}Z`, TYPE_FLOAT, z);
    const wConst = inputBlock(`${name}W`, TYPE_FLOAT, w);
    return addBlock(
        "VectorMergerBlock",
        name,
        TARGET_NEUTRAL,
        [input("xyIn"), input("zwIn"), input("xyzIn"), input("x", { id: x, output: xOut }), input("y", { id: y, output: yOut }), input("z", { id: zConst, output: "output" }), input("w", { id: wConst, output: "output" })],
        [output("xyzw"), output("xyz"), output("xy")]
    );
}

function scale(name: string, source: number, factorValue: number): number {
    const factor = inputBlock(`${name}Factor`, TYPE_FLOAT, factorValue);
    return addBlock("ScaleBlock", name, TARGET_NEUTRAL, [input("input", { id: source, output: "output" }), input("factor", { id: factor, output: "output" })], [output("output")]);
}

function clamp(name: string, source: number): number {
    return addBlock("ClampBlock", name, TARGET_NEUTRAL, [input("value", { id: source, output: "output" })], [output("output")], { minimum: 0, maximum: 1 });
}

function dot(name: string, left: number, leftOutput: string, right: number, rightOutput: string): number {
    return addBlock("DotBlock", name, TARGET_NEUTRAL, [input("left", { id: left, output: leftOutput }), input("right", { id: right, output: rightOutput })], [output("output")]);
}

function color(name: string, r: number, g: number, b: number): number {
    return addBlock(
        "ColorMergerBlock",
        name,
        TARGET_NEUTRAL,
        [input("rgb "), input("r", { id: r, output: "output" }), input("g", { id: g, output: "output" }), input("b", { id: b, output: "output" }), input("a")],
        [output("rgba"), output("rgb")],
        { rSwizzle: "r", gSwizzle: "g", bSwizzle: "b", aSwizzle: "a" }
    );
}

const position = inputBlock("position", TYPE_VECTOR3, null, 1);
const wvp = inputBlock("worldViewProjection", TYPE_MATRIX, null, 0, 6, TARGET_VERTEX);

const matrixCol0 = inputBlock("matrixCol0", TYPE_VECTOR4, [1.2, 0.2, 0, 0]);
const matrixCol1 = inputBlock("matrixCol1", TYPE_VECTOR4, [-0.15, 0.9, 0.25, 0]);
const matrixCol2 = inputBlock("matrixCol2", TYPE_VECTOR4, [0.35, -0.1, 1.1, 0]);
const matrixCol3 = inputBlock("matrixCol3", TYPE_VECTOR4, [0.05, 0.1, 0.2, 1]);
const matrix = addBlock(
    "MatrixBuilder",
    "MatrixBuilder",
    TARGET_NEUTRAL,
    [input("row0", { id: matrixCol0, output: "output" }), input("row1", { id: matrixCol1, output: "output" }), input("row2", { id: matrixCol2, output: "output" }), input("row3", { id: matrixCol3, output: "output" })],
    [output("output")]
);

const localTransform = transform("MatrixVertexTransform", position, "output", matrix);
const clipTransform = transform("TransformWVP", localTransform, "output", wvp);
const vertexOutput = addBlock("VertexOutputBlock", "VertexOutput", TARGET_VERTEX, [input("vector", { id: clipTransform, output: "output" })], []);

const probeX = inputBlock("matrixProbeX", TYPE_FLOAT, 0.35);
const probeY = inputBlock("matrixProbeY", TYPE_FLOAT, 0.65);
const probeVec4 = vector4("MatrixProbeVec4", probeX, "output", probeY, "output", 0.35, 1);
const transpose = addBlock("MatrixTransposeBlock", "MatrixTranspose", TARGET_NEUTRAL, [input("input", { id: matrix, output: "output" })], [output("output")]);
const matrixSplit = addBlock("MatrixSplitterBlock", "MatrixSplitter", TARGET_NEUTRAL, [input("input", { id: transpose, output: "output" })], [output("row0"), output("row1"), output("row2"), output("row3"), output("col0"), output("col1"), output("col2"), output("col3")]);
const rowDot = clamp("RedFromTransposedRow", scale("ScaleRedDot", dot("DotRow0Probe", matrixSplit, "row0", probeVec4, "xyzw"), 0.65));
const colDot = clamp("GreenFromSplitColumn", scale("ScaleGreenDot", dot("DotCol1Probe", matrixSplit, "col1", probeVec4, "xyzw"), 0.7));
const determinant = addBlock("MatrixDeterminantBlock", "MatrixDeterminant", TARGET_NEUTRAL, [input("input", { id: matrix, output: "output" })], [output("output")]);
const determinantBlue = clamp("BlueFromDeterminant", scale("ScaleDeterminant", determinant, 0.55));
const rgb = color("FragmentColor", rowDot, colDot, determinantBlue);
const fragmentOutput = addBlock("FragmentOutputBlock", "FragmentOutput", TARGET_FRAGMENT, [input("rgba"), input("rgb", { id: rgb, output: "rgb" }), input("a")], []);

export const SCENE85_NME_JSON = {
    forceAlphaBlending: false,
    id: "scene85nm",
    name: "Scene85NMEMatrix",
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
