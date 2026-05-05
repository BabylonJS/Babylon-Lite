// Scene 78 — NME scalar/vector math block coverage.

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

type NmeValue = number | number[] | { x: number; y: number; z?: number; w?: number };

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
        if (type === TYPE_FLOAT) {
            extra.valueType = "number";
        } else if (type === TYPE_VECTOR2) {
            extra.valueType = "BABYLON.Vector2";
        } else if (type === TYPE_VECTOR3) {
            extra.valueType = "BABYLON.Vector3";
        } else if (type === TYPE_VECTOR4) {
            extra.valueType = "BABYLON.Vector4";
        }
        extra.value = value;
    }
    return addBlock("InputBlock", name, target, [], [output("output")], extra);
}

function unary(className: string, name: string, inputName: string, source: number, sourceOutput = "output"): number {
    return addBlock(className, name, TARGET_NEUTRAL, [input(inputName, { id: source, output: sourceOutput })], [output("output")]);
}

function binary(className: string, name: string, left: number, right: number, leftOutput = "output", rightOutput = "output"): number {
    return addBlock(
        className,
        name,
        TARGET_NEUTRAL,
        [input("left", { id: left, output: leftOutput }), input("right", { id: right, output: rightOutput })],
        [output("output")]
    );
}

function split(name: string, source: number, sourceOutput: string, inputName: "xy" | "xyz" | "xyzw"): number {
    const serializedInputName = inputName === "xyzw" ? "xyzw" : `${inputName} `;
    return addBlock("VectorSplitterBlock", name, TARGET_NEUTRAL, [input(serializedInputName, { id: source, output: sourceOutput })], [output("xyz"), output("xy"), output("zw"), output("x"), output("y"), output("z"), output("w")]);
}

function merge3(name: string, x: number, y: number, z: number, xOutput = "output", yOutput = "output", zOutput = "output"): number {
    return addBlock(
        "VectorMergerBlock",
        name,
        TARGET_NEUTRAL,
        [
            input("xyzw "),
            input("xyz "),
            input("xy "),
            input("zw "),
            input("x", { id: x, output: xOutput }),
            input("y", { id: y, output: yOutput }),
            input("z", { id: z, output: zOutput }),
            input("w"),
        ],
        [output("xyzw"), output("xyz"), output("xy")]
    );
}

const position = inputBlock("position", TYPE_VECTOR3, null, 1);
const wvp = inputBlock("worldViewProjection", TYPE_MATRIX, null, 0, 6, TARGET_VERTEX);
const transform = addBlock(
    "TransformBlock",
    "Transform",
    TARGET_VERTEX,
    [input("vector", { id: position, output: "output" }), input("transform", { id: wvp, output: "output" })],
    [output("output"), output("xyz")],
    { complementZ: 0, complementW: 1 }
);
const vertexOutput = addBlock("VertexOutputBlock", "VertexOutput", TARGET_VERTEX, [input("vector", { id: transform, output: "output" })], []);

const uv = inputBlock("uv", TYPE_VECTOR2, null, 1);
const uvSplit = split("SplitUV", uv, "output", "xy");
const x = { id: uvSplit, output: "x" };
const y = { id: uvSplit, output: "y" };

const zero = inputBlock("zero", TYPE_FLOAT, 0);
const half = inputBlock("half", TYPE_FLOAT, 0.5);
const one = inputBlock("one", TYPE_FLOAT, 1);
const two = inputBlock("two", TYPE_FLOAT, 2);
const three = inputBlock("three", TYPE_FLOAT, 3);
const four = inputBlock("four", TYPE_FLOAT, 4);
const minusOne = inputBlock("minusOne", TYPE_FLOAT, -1);
const twoPi = inputBlock("twoPi", TYPE_FLOAT, 6.283185307179586);
const ior = inputBlock("ior", TYPE_FLOAT, 0.66);
const bias = inputBlock("bias", TYPE_FLOAT, 0);
const power = inputBlock("power", TYPE_FLOAT, 2);
const center = inputBlock("center", TYPE_VECTOR3, [0.25, 0.75, 0.5]);
const up = inputBlock("up", TYPE_VECTOR3, [0, 1, 0]);
const normalBase = inputBlock("normalBase", TYPE_VECTOR3, [0.2, 0.4, 1]);
const fresnelNormal = inputBlock("fresnelNormal", TYPE_VECTOR4, [0.2, 0.4, 1, 0]);

const xTimesFour = binary("MultiplyBlock", "xTimesFour", uvSplit, four, "x");
const modStripe = binary("ModBlock", "ModStripe", xTimesFour, one);
const xDivTwo = binary("DivideBlock", "DivideXByTwo", uvSplit, two, "x");
const xPlusOne = binary("AddBlock", "XPlusOne", uvSplit, one, "x");
const reciprocal = unary("ReciprocalBlock", "ReciprocalOneOverXPlusOne", "input", xPlusOne);
const xMinusHalf = binary("SubtractBlock", "XMinusHalf", uvSplit, half, "x");
const yMinusHalf = binary("SubtractBlock", "YMinusHalf", uvSplit, half, "y");
const atan2 = addBlock("ArcTan2Block", "ArcTan2Center", TARGET_NEUTRAL, [input("x", x), input("y", y)], [output("output")]);
const atanScaled = binary("DivideBlock", "ArcTan2Normalize", atan2, twoPi);
const atanMapped = binary("AddBlock", "ArcTan2Map", atanScaled, half);
const rSumA = binary("AddBlock", "RAddDivideMod", xDivTwo, modStripe);
const rSumB = binary("AddBlock", "RAddReciprocal", rSumA, reciprocal);
const rSumC = binary("AddBlock", "RAddArcTan2", rSumB, atanMapped);
const red = binary("DivideBlock", "RedAverage", rSumC, four);

const uvVec3 = merge3("UvVector3", xMinusHalf, yMinusHalf, half);
const lengthValue = unary("LengthBlock", "LengthUvVector", "value", uvVec3, "xyz");
const uvPosition = merge3("UvPosition", uvSplit, uvSplit, zero, "x", "y");
const distanceValue = binary("DistanceBlock", "DistanceToCenter", uvPosition, center, "xyz");
const normalizedUvVector = unary("NormalizeBlock", "NormalizeUvVector", "input", uvVec3, "xyz");
const crossVector = binary("CrossBlock", "CrossWithUp", normalizedUvVector, up);
const crossSplit = split("SplitCross", crossVector, "output", "xyz");
const crossHalf = binary("MultiplyBlock", "CrossZHalf", crossSplit, half, "z");
const crossMapped = binary("AddBlock", "CrossZMap", crossHalf, half);
const gSumA = binary("AddBlock", "GAddLengthDistance", lengthValue, distanceValue);
const gSumB = binary("AddBlock", "GAddCross", gSumA, crossMapped);
const green = binary("DivideBlock", "GreenAverage", gSumB, three);

const incidentRaw = merge3("IncidentRaw", xMinusHalf, yMinusHalf, minusOne);
const incident = unary("NormalizeBlock", "NormalizeIncident", "input", incidentRaw, "xyz");
const normal = unary("NormalizeBlock", "NormalizeNormal", "input", normalBase);
const reflectVector = addBlock("ReflectBlock", "ReflectIncident", TARGET_NEUTRAL, [input("incident", { id: incident, output: "output" }), input("normal", { id: normal, output: "output" })], [output("output")]);
const reflectSplit = split("SplitReflect", reflectVector, "output", "xyz");
const reflectHalf = binary("MultiplyBlock", "ReflectZHalf", reflectSplit, half, "z");
const reflectMapped = binary("AddBlock", "ReflectZMap", reflectHalf, half);
const refractVector = addBlock(
    "RefractBlock",
    "RefractIncident",
    TARGET_NEUTRAL,
    [input("incident", { id: incident, output: "output" }), input("normal", { id: normal, output: "output" }), input("ior", { id: ior, output: "output" })],
    [output("output")]
);
const refractSplit = split("SplitRefract", refractVector, "output", "xyz");
const refractHalf = binary("MultiplyBlock", "RefractZHalf", refractSplit, half, "z");
const refractMapped = binary("AddBlock", "RefractZMap", refractHalf, half);
const viewX = binary("SubtractBlock", "ViewX", half, uvSplit, "output", "x");
const viewY = binary("SubtractBlock", "ViewY", half, uvSplit, "output", "y");
const viewRaw = merge3("ViewRaw", viewX, viewY, one);
const viewDirection = unary("NormalizeBlock", "NormalizeViewDirection", "input", viewRaw, "xyz");
const fresnel = addBlock(
    "FresnelBlock",
    "Fresnel",
    TARGET_NEUTRAL,
    [input("worldNormal", { id: fresnelNormal, output: "output" }), input("viewDirection", { id: viewDirection, output: "output" }), input("bias", { id: bias, output: "output" }), input("power", { id: power, output: "output" })],
    [output("fresnel")]
);
const bSumA = binary("AddBlock", "BAddReflectRefract", reflectMapped, refractMapped);
const bSumB = binary("AddBlock", "BAddFresnel", bSumA, fresnel, "output", "fresnel");
const blue = binary("DivideBlock", "BlueAverage", bSumB, three);

const color = addBlock(
    "VectorMergerBlock",
    "MergeMathColor",
    TARGET_FRAGMENT,
    [input("xyzw "), input("xyz "), input("xy "), input("zw "), input("x", { id: red, output: "output" }), input("y", { id: green, output: "output" }), input("z", { id: blue, output: "output" }), input("w")],
    [output("xyzw"), output("xyz"), output("xy")]
);
const fragmentOutput = addBlock(
    "FragmentOutputBlock",
    "FragmentOutput",
    TARGET_FRAGMENT,
    [input("rgba"), input("rgb", { id: color, output: "xyz" }), input("a")],
    [],
    { convertToGammaSpace: false, convertToLinearSpace: false, useLogarithmicDepth: false }
);

export const SCENE78_NME_JSON = {
    tags: null,
    ignoreAlpha: false,
    maxSimultaneousLights: 4,
    mode: 0,
    forceAlphaBlending: false,
    id: "scene78nm",
    name: "Scene78NMEMath",
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
