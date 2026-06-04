// Scene 86 — NME scene/mesh state compatibility.
// Shared deterministic graph parsed by both Babylon.js and Babylon Lite. It covers:
// MeshAttributeExistsBlock, ClipPlanesBlock, and a compatibility-only
// ReflectionTextureBaseBlock registration.

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

export interface Scene86MeshData {
    readonly name: string;
    readonly x: number;
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly indices: Uint32Array;
    readonly uvs?: Float32Array;
    readonly tangents?: Float32Array;
    readonly colors?: Float32Array;
}

const TARGET_VERTEX = 1;
const TARGET_FRAGMENT = 2;
const TARGET_NEUTRAL = 4;

const TYPE_FLOAT = 1;
const TYPE_VECTOR2 = 4;
const TYPE_VECTOR3 = 8;
const TYPE_VECTOR4 = 16;
const TYPE_MATRIX = 128;

const SYSTEM_WORLD = 1;
const SYSTEM_WORLD_VIEW_PROJECTION = 6;

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

function transform(name: string, vector: number, vectorOutput: string, matrix: number): number {
    return addBlock("TransformBlock", name, TARGET_VERTEX, [input("vector", { id: vector, output: vectorOutput }), input("transform", { id: matrix, output: "output" })], [output("output"), output("xyz")], {
        complementZ: 0,
        complementW: 1,
    });
}

function meshAttribute(name: string, attributeType: number, source: number, fallback: number): number {
    return addBlock("MeshAttributeExistsBlock", name, TARGET_NEUTRAL, [input("input", { id: source, output: "output" }), input("fallback", { id: fallback, output: "output" })], [output("output")], {
        attributeType,
    });
}

function vectorSplitter(name: string, source: number, sourceOutput: string): number {
    return addBlock("VectorSplitterBlock", name, TARGET_NEUTRAL, [input("xyzw", { id: source, output: sourceOutput }), input("xyz"), input("xy")], [output("xyzw"), output("xyz"), output("xy"), output("x"), output("y"), output("z"), output("w")]);
}

function colorSplitter(name: string, source: number): number {
    return addBlock("ColorSplitterBlock", name, TARGET_NEUTRAL, [input("rgba", { id: source, output: "output" }), input("rgb")], [output("rgba"), output("rgb"), output("r"), output("g"), output("b"), output("a")]);
}

function scale(name: string, source: number, sourceOutput: string, factorValue: number): number {
    const factor = inputBlock(`${name}Factor`, TYPE_FLOAT, factorValue);
    return addBlock("ScaleBlock", name, TARGET_NEUTRAL, [input("input", { id: source, output: sourceOutput }), input("factor", { id: factor, output: "output" })], [output("output")]);
}

function add(name: string, left: number, leftOutput: string, right: number, rightOutput: string): number {
    return addBlock("AddBlock", name, TARGET_NEUTRAL, [input("left", { id: left, output: leftOutput }), input("right", { id: right, output: rightOutput })], [output("output")]);
}

function clamp(name: string, source: number): number {
    return addBlock("ClampBlock", name, TARGET_NEUTRAL, [input("value", { id: source, output: "output" })], [output("output")], { minimum: 0, maximum: 1 });
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
const uv = inputBlock("uv", TYPE_VECTOR2, null, 1);
const colorAttr = inputBlock("color", TYPE_VECTOR4, null, 1);
const tangent = inputBlock("tangent", TYPE_VECTOR4, null, 1);
const world = inputBlock("world", TYPE_MATRIX, null, 0, SYSTEM_WORLD, TARGET_VERTEX);
const worldViewProjection = inputBlock("worldViewProjection", TYPE_MATRIX, null, 0, SYSTEM_WORLD_VIEW_PROJECTION, TARGET_VERTEX);

const worldPosition = transform("WorldPosition", position, "output", world);
const clipPosition = transform("ClipPosition", position, "output", worldViewProjection);
const clipPlanes = addBlock("ClipPlanesBlock", "ClipPlanes", TARGET_VERTEX | TARGET_FRAGMENT, [input("worldPosition", { id: worldPosition, output: "output" })], []);
const vertexOutput = addBlock("VertexOutputBlock", "VertexOutput", TARGET_VERTEX, [input("vector", { id: clipPosition, output: "output" })], []);

const fallbackUv = inputBlock("FallbackUV", TYPE_VECTOR2, [0.05, 0.9]);
const fallbackColor = inputBlock("FallbackColor", TYPE_VECTOR4, [1.0, 0.06, 0.03, 1.0]);
const fallbackTangent = inputBlock("FallbackTangent", TYPE_VECTOR4, [0.2, 0.0, 0.0, 1.0]);

const uvExists = meshAttribute("UVExists", 4, uv, fallbackUv);
const colorExists = meshAttribute("ColorExists", 3, colorAttr, fallbackColor);
const tangentExists = meshAttribute("TangentExists", 2, tangent, fallbackTangent);

const uvSplit = vectorSplitter("SplitUV", uvExists, "output");
const colorSplit = colorSplitter("SplitColor", colorExists);
const tangentSplit = vectorSplitter("SplitTangent", tangentExists, "output");

const red = clamp("FinalRed", add("AddRedUV", scale("ColorRedWeight", colorSplit, "r", 0.7), "output", scale("UVRedWeight", uvSplit, "x", 0.3), "output"));
const green = clamp("FinalGreen", add("AddGreenUV", scale("ColorGreenWeight", colorSplit, "g", 0.7), "output", scale("UVGreenWeight", uvSplit, "y", 0.3), "output"));
const blue = clamp("FinalBlue", add("AddBlueTangent", scale("ColorBlueWeight", colorSplit, "b", 0.7), "output", scale("TangentBlueWeight", tangentSplit, "x", 0.3), "output"));
const rgb = color("FragmentColor", red, green, blue);
const fragmentOutput = addBlock("FragmentOutputBlock", "FragmentOutput", TARGET_FRAGMENT, [input("rgba"), input("rgb", { id: rgb, output: "rgb" }), input("a")], []);

addBlock("ReflectionTextureBaseBlock", "ReflectionTextureBaseCompatibility", TARGET_FRAGMENT | TARGET_VERTEX, [], [], {
    generateOnlyFragmentCode: false,
});

export const SCENE86_CLIP_PLANE: readonly [number, number, number, number] = [0.8, 0.4, 0, -0.45];

export const SCENE86_NME_JSON = {
    forceAlphaBlending: false,
    id: "scene86nm",
    name: "Scene86NMESceneState",
    customType: "BABYLON.NodeMaterial",
    checkReadyOnEveryCall: false,
    checkReadyOnlyOnce: false,
    state: "",
    alpha: 1,
    backFaceCulling: false,
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
    outputNodes: [vertexOutput, fragmentOutput, clipPlanes],
};

const POSITIONS = new Float32Array([-0.42, -0.55, 0, 0.42, -0.55, 0, 0.42, 0.55, 0, -0.42, 0.55, 0]);
const NORMALS = new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3]);
const UVS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const TANGENTS = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
const COLORS = new Float32Array([0.05, 0.25, 1, 1, 0.1, 0.9, 0.35, 1, 1, 0.85, 0.1, 1, 0.7, 0.15, 0.95, 1]);

function clone(src: Float32Array): Float32Array {
    return new Float32Array(src);
}

export function createScene86MeshData(): Scene86MeshData[] {
    return [
        { name: "no-uv-color-tangent", x: -1.15, positions: clone(POSITIONS), normals: clone(NORMALS), indices: new Uint32Array(INDICES) },
        { name: "uv-only", x: 0, positions: clone(POSITIONS), normals: clone(NORMALS), indices: new Uint32Array(INDICES), uvs: clone(UVS) },
        { name: "uv-color-tangent", x: 1.15, positions: clone(POSITIONS), normals: clone(NORMALS), indices: new Uint32Array(INDICES), uvs: clone(UVS), tangents: clone(TANGENTS), colors: clone(COLORS) },
    ];
}
