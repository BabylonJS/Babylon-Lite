// Scene 80 — NME color operations.
// Deterministic UV ramp covering Gradient, RGB↔HSL conversion, Posterize,
// Desaturate, ReplaceColor, and ColorMerger scalar/rgb paths.

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

function colorConverter(name: string, inputKind: "rgb" | "hsl", source: number, sourceOutput: string): number {
    return addBlock(
        "ColorConverterBlock",
        name,
        TARGET_NEUTRAL,
        [input("rgb ", inputKind === "rgb" ? { id: source, output: sourceOutput } : undefined), input("hsl ", inputKind === "hsl" ? { id: source, output: sourceOutput } : undefined)],
        [output("rgb"), output("hsl")]
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

const gradient = addBlock("GradientBlock", "ColorRamp", TARGET_NEUTRAL, [input("gradient", { id: uvSplit, output: "x" })], [output("output")], {
    colorSteps: [
        { step: 0, color: { r: 0.02, g: 0.04, b: 0.42 } },
        { step: 0.28, color: { r: 0.0, g: 0.82, b: 0.95 } },
        { step: 0.58, color: { r: 1.0, g: 0.88, b: 0.08 } },
        { step: 1, color: { r: 0.95, g: 0.08, b: 0.62 } },
    ],
});
const rgbToHsl = colorConverter("RgbToHsl", "rgb", gradient, "output");
const hslSplit = split("SplitHsl", rgbToHsl, "hsl", "xyz");
const fiveSteps = inputBlock("fiveSteps", TYPE_FLOAT, 5);
const posterHue = addBlock("PosterizeBlock", "PosterizeHue", TARGET_NEUTRAL, [input("value", { id: hslSplit, output: "x" }), input("steps", { id: fiveSteps, output: "output" })], [output("output")]);
const mergedHsl = addBlock(
    "ColorMergerBlock",
    "MergePosterizedHsl",
    TARGET_NEUTRAL,
    [input("rgb "), input("r", { id: posterHue, output: "output" }), input("g", { id: hslSplit, output: "y" }), input("b", { id: hslSplit, output: "z" }), input("a")],
    [output("rgba"), output("rgb")],
    { rSwizzle: "r", gSwizzle: "g", bSwizzle: "b", aSwizzle: "a" }
);
const hslToRgb = colorConverter("HslToRgb", "hsl", mergedHsl, "rgb");
const desaturate = addBlock("DesaturateBlock", "DesaturateByY", TARGET_NEUTRAL, [input("color", { id: hslToRgb, output: "rgb" }), input("level", { id: uvSplit, output: "y" })], [output("output")]);

const reference = inputBlock("replaceReference", TYPE_COLOR3, [0.44, 0.44, 0.44]);
const replacement = inputBlock("replaceHotPink", TYPE_COLOR3, [1.0, 0.04, 0.02]);
const threshold = inputBlock("replaceDistance", TYPE_FLOAT, 0.18);
const replace = addBlock(
    "ReplaceColorBlock",
    "ReplaceGreyBand",
    TARGET_NEUTRAL,
    [input("value", { id: desaturate, output: "output" }), input("reference", { id: reference, output: "output" }), input("distance", { id: threshold, output: "output" }), input("replacement", { id: replacement, output: "output" })],
    [output("output")]
);

const finalColor = addBlock(
    "ColorMergerBlock",
    "FinalSwapGreenBlue",
    TARGET_NEUTRAL,
    [input("rgb ", { id: replace, output: "output" }), input("r"), input("g"), input("b"), input("a")],
    [output("rgba"), output("rgb")],
    { rSwizzle: "r", gSwizzle: "b", bSwizzle: "g", aSwizzle: "a" }
);

const fragmentOutput = addBlock("FragmentOutputBlock", "FragmentOutput", TARGET_FRAGMENT, [input("rgba"), input("rgb", { id: finalColor, output: "rgb" }), input("a")], [], {
    convertToGammaSpace: false,
    convertToLinearSpace: false,
    useLogarithmicDepth: false,
});

export const SCENE80_NME_JSON = {
    tags: null,
    ignoreAlpha: false,
    maxSimultaneousLights: 4,
    mode: 0,
    forceAlphaBlending: false,
    id: "scene80nm",
    name: "Scene80NMEColor",
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
