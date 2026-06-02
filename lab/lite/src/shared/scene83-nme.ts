// Scene 83 — NME normals, derivatives, tangent basis, normal blend, and AO.
// A deterministic plane graph derives a UV height field, converts it to normal-map
// color, blends in derivative normals, perturbs a lit normal, and applies a
// constant-depth AmbientOcclusionBlock darkening factor.

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
const TARGET_VERTEX_AND_FRAGMENT = 3;
const TARGET_NEUTRAL = 4;

const TYPE_FLOAT = 1;
const TYPE_VECTOR2 = 4;
const TYPE_VECTOR3 = 8;
const TYPE_VECTOR4 = 16;
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
    if (type === TYPE_VECTOR4) {
        return "BABYLON.Vector4";
    }
    if (type === TYPE_COLOR3) {
        return "BABYLON.Color3";
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

function split(name: string, source: number, sourceOutput: string, inputName: "xy" | "xyz" | "xyzw"): number {
    return addBlock("VectorSplitterBlock", name, TARGET_NEUTRAL, [input(inputName === "xyzw" ? "xyzw" : `${inputName} `, { id: source, output: sourceOutput })], [output("xyz"), output("xy"), output("zw"), output("x"), output("y"), output("z"), output("w")]);
}

function scale(name: string, source: number, sourceOutput: string, factor: number): number {
    return addBlock("ScaleBlock", name, TARGET_NEUTRAL, [input("input", { id: source, output: sourceOutput }), input("factor", { id: factor, output: "output" })], [output("output")]);
}

function add(name: string, left: number, leftOutput: string, right: number, rightOutput: string): number {
    return addBlock("AddBlock", name, TARGET_NEUTRAL, [input("left", { id: left, output: leftOutput }), input("right", { id: right, output: rightOutput })], [output("output")]);
}

function multiply(name: string, left: number, leftOutput: string, right: number, rightOutput: string): number {
    return addBlock("MultiplyBlock", name, TARGET_NEUTRAL, [input("left", { id: left, output: leftOutput }), input("right", { id: right, output: rightOutput })], [output("output")]);
}

function trig(name: string, source: number, sourceOutput: string, operation: number): number {
    return addBlock("TrigonometryBlock", name, TARGET_NEUTRAL, [input("input", { id: source, output: sourceOutput })], [output("output")], { operation });
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

function vector3(name: string, xy: number, xyOutput: string, z: number): number {
    return addBlock(
        "VectorMergerBlock",
        name,
        TARGET_NEUTRAL,
        [input("xyzw "), input("xyz "), input("xy ", { id: xy, output: xyOutput }), input("zw "), input("x"), input("y"), input("z", { id: z, output: "output" }), input("w")],
        [output("xyzw"), output("xyz"), output("xy")]
    );
}

const position = inputBlock("position", TYPE_VECTOR3, null, 1);
const normal = inputBlock("normal", TYPE_VECTOR3, null, 1);
const uv = inputBlock("uv", TYPE_VECTOR2, null, 1);
inputBlock("position", TYPE_VECTOR3, null, 1);
const world = inputBlock("world", TYPE_MATRIX, null, 0, 1, TARGET_VERTEX);
const wvp = inputBlock("worldViewProjection", TYPE_MATRIX, null, 0, 6, TARGET_VERTEX);
const cameraPosition = inputBlock("cameraPosition", TYPE_VECTOR3, null, 0, 7, TARGET_FRAGMENT);

const clipPos = transform("TransformWVP", position, wvp, 1);
const worldPos = transform("TransformWorldPos", position, world, 1);
const worldNormal = transform("TransformWorldNormal", normal, world, 0);
split("SplitWorldPos", worldPos, "output", "xyzw");
split("SplitWorldNormal", worldNormal, "output", "xyzw");
const vertexOutput = addBlock("VertexOutputBlock", "VertexOutput", TARGET_VERTEX, [input("vector", { id: clipPos, output: "output" })], []);

const uvSplit = split("SplitUV", uv, "output", "xy");
const zero = inputBlock("zero", TYPE_FLOAT, 0.0);
const uvPosition = vector3("UvWorldPosition", uv, "output", zero);
split("SplitUvWorldPosition", uvPosition, "xyzw", "xyzw");
addBlock(
    "TextureBlock",
    "PositionSample",
    TARGET_VERTEX_AND_FRAGMENT,
    [input("uv", { id: uv, output: "output" }), input("source"), input("layer"), input("lod")],
    [output("rgba"), output("rgb"), output("r"), output("g"), output("b"), output("a"), output("level")],
    {
        convertToGammaSpace: false,
        convertToLinearSpace: false,
        fragmentOnly: false,
        disableLevelMultiplication: true,
        texture: {
            name: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAF0lEQVR4AWNkYGj4/5+BgYGF4T8DGAAAKaYDg36vB4oAAAAASUVORK5CYII=",
            url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAF0lEQVR4AWNkYGj4/5+BgYGF4T8DGAAAKaYDg36vB4oAAAAASUVORK5CYII=",
            noMipmap: false,
            invertY: false,
            samplingMode: 2,
            wrapU: 0,
            wrapV: 0,
        },
    }
);
const freqX = inputBlock("heightFreqX", TYPE_FLOAT, 18.0);
const freqY = inputBlock("heightFreqY", TYPE_FLOAT, 15.0);
const heightAmp = inputBlock("heightAmp", TYPE_FLOAT, 0.075);
const xPhase = scale("HeightXPhase", uvSplit, "x", freqX);
const yPhase = scale("HeightYPhase", uvSplit, "y", freqY);
const sinX = trig("HeightSinX", xPhase, "output", 1);
const cosY = trig("HeightCosY", yPhase, "output", 0);
const heightSum = add("HeightSum", sinX, "output", cosY, "output");
const height = scale("Height", heightSum, "output", heightAmp);

const tangent = inputBlock("worldTangentConst", TYPE_VECTOR4, [1, 0, 0, 1], 0, null, TARGET_FRAGMENT);
const normalConst = inputBlock("worldNormalConst", TYPE_VECTOR3, [0, 0, -1], 0, null, TARGET_FRAGMENT);
const h2n = addBlock(
    "HeightToNormalBlock",
    "HeightToNormal",
    TARGET_FRAGMENT,
    [input("input", { id: height, output: "output" }), input("worldPosition", { id: uvPosition, output: "xyz" }), input("worldNormal", { id: normalConst, output: "output" }), input("worldTangent", { id: tangent, output: "output" })],
    [output("output"), output("xyz")],
    { generateInWorldSpace: false, automaticNormalizationNormal: true, automaticNormalizationTangent: true }
);

const deriv = addBlock("DerivativeBlock", "DerivativeHeight", TARGET_FRAGMENT, [input("input", { id: height, output: "output" })], [output("dx"), output("dy")]);
const normalHalf = inputBlock("normalHalf", TYPE_FLOAT, 0.5);
const derivScaleK = inputBlock("derivativeNormalScale", TYPE_FLOAT, 12.0);
const one = inputBlock("one", TYPE_FLOAT, 1.0);
const dxScaled = scale("DerivativeDxScale", deriv, "dx", derivScaleK);
const dyScaled = scale("DerivativeDyScale", deriv, "dy", derivScaleK);
const dxColor = add("DerivativeDxColor", normalHalf, "output", dxScaled, "output");
const dyColor = add("DerivativeDyColor", normalHalf, "output", dyScaled, "output");
const derivativeNormalColor = color("DerivativeNormalColor", dxColor, "output", dyColor, "output", one, "output");

const normalBlend = addBlock("NormalBlendBlock", "NormalBlend", TARGET_NEUTRAL, [input("normalMap0", { id: h2n, output: "xyz" }), input("normalMap1", { id: derivativeNormalColor, output: "rgb" })], [output("output")]);
const perturbStrength = inputBlock("perturbStrength", TYPE_FLOAT, 0.75);
const tbn = addBlock("TBNBlock", "TBN", TARGET_FRAGMENT, [input("normal", { id: normalConst, output: "output" }), input("tangent", { id: tangent, output: "output" }), input("world", { id: world, output: "output" })], [output("TBN"), output("row0"), output("row1"), output("row2")]);
const perturb = addBlock(
    "PerturbNormalBlock",
    "PerturbNormal",
    TARGET_NEUTRAL,
    [
        input("worldPosition", { id: worldPos, output: "output" }),
        input("worldNormal", { id: normalConst, output: "output" }),
        input("worldTangent", { id: tangent, output: "output" }),
        input("uv", { id: uv, output: "output" }),
        input("normalMapColor", { id: normalBlend, output: "output" }),
        input("strength", { id: perturbStrength, output: "output" }),
        input("TBN", { id: tbn, output: "TBN" }),
    ],
    [output("output")],
    { invertX: false, invertY: false }
);

const tbnAbs = trig("TbnRow2Abs", tbn, "row2", 2);
const tbnTintScale = inputBlock("tbnTintScale", TYPE_FLOAT, 0.08);
const tbnTint = scale("TbnTint", tbnAbs, "output", tbnTintScale);
const baseColor = inputBlock("baseColor", TYPE_COLOR3, [0.82, 0.56, 0.28]);
const litColor = add("LitColorWithTbnTint", baseColor, "output", tbnTint, "output");

const light = addBlock(
    "LightBlock",
    "Light",
    TARGET_FRAGMENT,
    [
        input("worldPosition", { id: worldPos, output: "output" }),
        input("worldNormal", { id: perturb, output: "output" }),
        input("cameraPosition", { id: cameraPosition, output: "output" }),
        input("diffuseColor", { id: litColor, output: "output" }),
        input("specularColor"),
        input("glossiness"),
        input("glossPower"),
        input("view"),
    ],
    [output("diffuseOutput"), output("specularOutput"), output("shadow")]
);

const aoSource = addBlock("ImageSourceBlock", "AoDepth", TARGET_VERTEX_AND_FRAGMENT, [], [output("source"), output("dimensions")]);
const screenSize = inputBlock("screenSize", TYPE_VECTOR2, [1280, 720]);
const ao = addBlock("AmbientOcclusionBlock", "AmbientOcclusion", TARGET_FRAGMENT, [input("source", { id: aoSource, output: "source" }), input("screenSize", { id: screenSize, output: "output" })], [output("occlusion")], {
    radius: 0.0001,
    area: 0.1,
    fallOff: -0.1,
});
const finalColor = multiply("ApplyAO", light, "diffuseOutput", ao, "occlusion");

const fragmentOutput = addBlock("FragmentOutputBlock", "FragmentOutput", TARGET_FRAGMENT, [input("rgba"), input("rgb", { id: finalColor, output: "output" }), input("a")], [], {
    convertToGammaSpace: false,
    convertToLinearSpace: false,
    useLogarithmicDepth: false,
});

export const SCENE83_NME_JSON = {
    tags: null,
    ignoreAlpha: false,
    maxSimultaneousLights: 4,
    mode: 0,
    forceAlphaBlending: false,
    id: "scene83nm",
    name: "Scene83NMENormals",
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

export const SCENE83_POSITION_TEXTURE_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAF0lEQVR4AWNkYGj4/5+BgYGF4T8DGAAAKaYDg36vB4oAAAAASUVORK5CYII=";
