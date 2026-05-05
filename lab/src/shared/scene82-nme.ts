// Scene 82 — NME procedural noise.
// One deterministic full-plane graph split into four UV quadrants:
// Cloud, Simplex/Perlin 3D, Voronoi, and Worley 3D.

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
const TYPE_COLOR3 = 32;
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
    if (type === TYPE_COLOR3) {
        return "BABYLON.Color3";
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

function split(name: string, source: number, sourceOutput: string, inputName: "xy" | "xyz"): number {
    return addBlock("VectorSplitterBlock", name, TARGET_NEUTRAL, [input(`${inputName} `, { id: source, output: sourceOutput })], [output("xyz"), output("xy"), output("zw"), output("x"), output("y"), output("z"), output("w")]);
}

function vector3(name: string, xy: number, xyOutput: string, z: number): number {
    return addBlock(
        "VectorMergerBlock",
        name,
        TARGET_NEUTRAL,
        [input("xyzw "), input("xyz "), input("xy ", { id: xy, output: xyOutput }), input("zw "), input("x"), input("y"), input("z", { id: z, output: "output" }), input("w")],
        [output("xyzw"), output("xyz"), output("xy")]
    );
}

function scale(name: string, source: number, sourceOutput: string, factor: number): number {
    return addBlock("ScaleBlock", name, TARGET_NEUTRAL, [input("input", { id: source, output: sourceOutput }), input("factor", { id: factor, output: "output" })], [output("output")]);
}

function add(name: string, left: number, leftOutput: string, right: number, rightOutput: string): number {
    return addBlock("AddBlock", name, TARGET_NEUTRAL, [input("left", { id: left, output: leftOutput }), input("right", { id: right, output: rightOutput })], [output("output")]);
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

function selectColor(name: string, a: number, aOutput: string, b: number, bOutput: string, condition: number, trueBlock: number, trueOutput: string, falseBlock: number, falseOutput: string): number {
    return addBlock(
        "ConditionalBlock",
        name,
        TARGET_NEUTRAL,
        [input("a", { id: a, output: aOutput }), input("b", { id: b, output: bOutput }), input("true", { id: trueBlock, output: trueOutput }), input("false", { id: falseBlock, output: falseOutput })],
        [output("output")],
        { condition }
    );
}

const position = inputBlock("position", TYPE_VECTOR3, null, 1);
const wvp = inputBlock("worldViewProjection", TYPE_MATRIX, null, 0, 6, TARGET_VERTEX);
const transform = addBlock("TransformBlock", "Transform", TARGET_VERTEX, [input("vector", { id: position, output: "output" }), input("transform", { id: wvp, output: "output" })], [output("output"), output("xyz")], {
    complementZ: 0,
    complementW: 1,
});
const vertexOutput = addBlock("VertexOutputBlock", "VertexOutput", TARGET_VERTEX, [input("vector", { id: transform, output: "output" })], []);

const uv = inputBlock("uv", TYPE_VECTOR2, null, 1);
const uvSplit = split("SplitUV", uv, "output", "xy");

const half = inputBlock("quadrantHalf", TYPE_FLOAT, 0.5);
const one = inputBlock("one", TYPE_FLOAT, 1);
const blueBias = inputBlock("blueBias", TYPE_FLOAT, 0.88);
const yellowBias = inputBlock("yellowBias", TYPE_FLOAT, 0.18);
const simplexZ = inputBlock("simplexSeedZ", TYPE_FLOAT, 0.37);
const worleyZ = inputBlock("worleySeedZ", TYPE_FLOAT, 0.61);
const cloudScaleK = inputBlock("cloudScale", TYPE_FLOAT, 5.25);
const simplexScaleK = inputBlock("simplexScale", TYPE_FLOAT, 7.4);
const voronoiDensity = inputBlock("voronoiDensity", TYPE_FLOAT, 8.0);
const voronoiOffset = inputBlock("voronoiOffset", TYPE_FLOAT, 1.125);
const worleyScaleK = inputBlock("worleyScale", TYPE_FLOAT, 4.6);
const worleyJitter = inputBlock("worleyJitter", TYPE_FLOAT, 0.72);

const cloudSeed = scale("CloudSeedScale", uv, "output", cloudScaleK);
const cloudChaos = inputBlock("cloudChaos", TYPE_VECTOR2, [0.13, 0.31]);
const cloudOffsetX = inputBlock("cloudOffsetX", TYPE_FLOAT, 2.0);
const cloudOffsetY = inputBlock("cloudOffsetY", TYPE_FLOAT, -1.25);
const cloudNoise = addBlock(
    "CloudBlock",
    "CloudNoise",
    TARGET_NEUTRAL,
    [input("seed", { id: cloudSeed, output: "output" }), input("chaos", { id: cloudChaos, output: "output" }), input("offsetX", { id: cloudOffsetX, output: "output" }), input("offsetY", { id: cloudOffsetY, output: "output" }), input("offsetZ")],
    [output("output")],
    { octaves: 5 }
);
const cloudColor = color("CloudBlue", cloudNoise, "output", cloudNoise, "output", blueBias, "output");

const simplexSeedUv = scale("SimplexSeedUv", uv, "output", simplexScaleK);
const simplexSeed = vector3("SimplexSeed3", simplexSeedUv, "output", simplexZ);
const simplexRaw = addBlock("SimplexPerlin3DBlock", "SimplexNoise", TARGET_NEUTRAL, [input("seed", { id: simplexSeed, output: "xyz" })], [output("output")]);
const simplexPlusOne = add("SimplexPlusOne", simplexRaw, "output", one, "output");
const halfScale = inputBlock("halfScale", TYPE_FLOAT, 0.5);
const simplex01 = scale("SimplexTo01", simplexPlusOne, "output", halfScale);
const simplexColor = color("SimplexRed", simplex01, "output", yellowBias, "output", simplex01, "output");

const voronoi = addBlock("VoronoiNoiseBlock", "VoronoiNoise", TARGET_NEUTRAL, [input("seed", { id: uv, output: "output" }), input("offset", { id: voronoiOffset, output: "output" }), input("density", { id: voronoiDensity, output: "output" })], [output("output"), output("cells")]);
const voronoiColor = color("VoronoiGreen", voronoi, "output", voronoi, "cells", yellowBias, "output");

const worleySeedUv = scale("WorleySeedUv", uv, "output", worleyScaleK);
const worleySeed = vector3("WorleySeed3", worleySeedUv, "output", worleyZ);
const worley = addBlock("WorleyNoise3DBlock", "WorleyNoise", TARGET_NEUTRAL, [input("seed", { id: worleySeed, output: "xyz" }), input("jitter", { id: worleyJitter, output: "output" })], [output("output"), output("x"), output("y")], {
    manhattanDistance: false,
});
const worleyColor = color("WorleyPurple", worley, "x", yellowBias, "output", worley, "y");

const bottomRow = selectColor("BottomCloudOrSimplex", uvSplit, "x", half, "output", 2, cloudColor, "rgb", simplexColor, "rgb");
const topRow = selectColor("TopVoronoiOrWorley", uvSplit, "x", half, "output", 2, voronoiColor, "rgb", worleyColor, "rgb");
const finalColor = selectColor("FinalTopOrBottom", uvSplit, "y", half, "output", 3, topRow, "output", bottomRow, "output");

const fragmentOutput = addBlock("FragmentOutputBlock", "FragmentOutput", TARGET_FRAGMENT, [input("rgba"), input("rgb", { id: finalColor, output: "output" }), input("a")], [], {
    convertToGammaSpace: false,
    convertToLinearSpace: false,
    useLogarithmicDepth: false,
});

export const SCENE82_NME_JSON = {
    tags: null,
    ignoreAlpha: false,
    maxSimultaneousLights: 4,
    mode: 0,
    forceAlphaBlending: false,
    id: "scene82nm",
    name: "Scene82NMENoise",
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
