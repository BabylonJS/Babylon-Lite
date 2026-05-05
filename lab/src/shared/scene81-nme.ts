// Scene 81 — NME UV/projection mapping.
// Covers PannerBlock, Rotate2dBlock, TriPlanarBlock, and BiPlanarBlock with a
// deterministic constant-time atlas texture on UV-sphere geometry.

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

function textureOutputs(): NmeOutput[] {
    return [output("rgba"), output("rgb"), output("r"), output("g"), output("b"), output("a"), output("level")];
}

function textureBlock(className: "TextureBlock" | "TriPlanarBlock" | "BiPlanarBlock", name: string, inputs: NmeInput[], extra: Record<string, unknown> = {}): number {
    return addBlock(className, name, TARGET_NEUTRAL, inputs, textureOutputs(), {
        convertToGammaSpace: false,
        convertToLinearSpace: false,
        disableLevelMultiplication: false,
        texture: null,
        ...extra,
    });
}

const position = inputBlock("position", TYPE_VECTOR3, null, 1);
const normal = inputBlock("normal", TYPE_VECTOR3, null, 1);
const uv = inputBlock("uv", TYPE_VECTOR2, null, 1);
const wvp = inputBlock("worldViewProjection", TYPE_MATRIX, null, 0, 6, TARGET_VERTEX);
const transform = addBlock("TransformBlock", "Transform", TARGET_VERTEX, [input("vector", { id: position, output: "output" }), input("transform", { id: wvp, output: "output" })], [output("output"), output("xyz")], {
    complementZ: 0,
    complementW: 1,
});
const vertexOutput = addBlock("VertexOutputBlock", "VertexOutput", TARGET_VERTEX, [input("vector", { id: transform, output: "output" })], []);

// Constant-time UV path: panner and rotate are both active, but no live clock is
// used. The rotated/panned UVs sample an atlas as the first color contribution.
const panSpeed = inputBlock("panSpeed", TYPE_VECTOR2, [0.37, -0.22]);
const frozenTime = inputBlock("frozenTime", TYPE_FLOAT, 1.75);
const panner = addBlock("PannerBlock", "FrozenPanner", TARGET_NEUTRAL, [input("uv", { id: uv, output: "output" }), input("speed", { id: panSpeed, output: "output" }), input("time", { id: frozenTime, output: "output" })], [output("output")]);
const angle = inputBlock("rotateRadians", TYPE_FLOAT, 0.72);
const rotate = addBlock("Rotate2dBlock", "RotatePannedUV", TARGET_NEUTRAL, [input("input", { id: panner, output: "output" }), input("angle", { id: angle, output: "output" })], [output("output")]);
const uvAtlas = textureBlock("TextureBlock", "AtlasUV", [input("uv", { id: rotate, output: "output" }), input("source"), input("layer"), input("lod")]);

// Projection path: object position + normal drive triplanar and biplanar
// projection on the same atlas. Different sharpness values make both
// projections visually distinct on the sphere.
const triSharpness = inputBlock("triSharpness", TYPE_FLOAT, 4);
const tri = textureBlock(
    "TriPlanarBlock",
    "TriAtlas",
    [input("position", { id: position, output: "output" }), input("normal", { id: normal, output: "output" }), input("sharpness", { id: triSharpness, output: "output" }), input("source"), input("sourceY"), input("sourceZ")],
    { projectAsCube: true }
);

const biSharpness = inputBlock("biSharpness", TYPE_FLOAT, 6);
const bi = textureBlock("BiPlanarBlock", "BiAtlas", [input("position", { id: position, output: "output" }), input("normal", { id: normal, output: "output" }), input("sharpness", { id: biSharpness, output: "output" }), input("source"), input("sourceY")]);

// Average the three RGB contributions.
const uvPlusTri = addBlock("AddBlock", "UvPlusTri", TARGET_NEUTRAL, [input("left", { id: uvAtlas, output: "rgb" }), input("right", { id: tri, output: "rgb" })], [output("output")]);
const allThree = addBlock("AddBlock", "AddBi", TARGET_NEUTRAL, [input("left", { id: uvPlusTri, output: "output" }), input("right", { id: bi, output: "rgb" })], [output("output")]);
const oneThird = inputBlock("oneThird", TYPE_FLOAT, 1 / 3);
const finalColor = addBlock("ScaleBlock", "AverageProjectionColors", TARGET_NEUTRAL, [input("input", { id: allThree, output: "output" }), input("factor", { id: oneThird, output: "output" })], [output("output")]);

const fragmentOutput = addBlock("FragmentOutputBlock", "FragmentOutput", TARGET_FRAGMENT, [input("rgba"), input("rgb", { id: finalColor, output: "output" }), input("a")], [], {
    convertToGammaSpace: false,
    convertToLinearSpace: false,
    useLogarithmicDepth: false,
});

export const SCENE81_NME_JSON = {
    tags: null,
    ignoreAlpha: false,
    maxSimultaneousLights: 4,
    mode: 0,
    forceAlphaBlending: false,
    id: "scene81nm",
    name: "Scene81NMEUvProjection",
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

export const SCENE81_TEXTURE_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAklEQVR4AewaftIAAAO+SURBVOXBMW6rSBzA4d+MLJpQIbEHGNd0VKbAJxmfzXOSUJCKrdg2cwEktsENW8w+S/lLURQ7kBd4Svg+BQR+CSGwNqUUIoTAmpRSXGleKKXYCqUUQocQEEopfjqlFCKEwI5fQggopbhSSjGUlrXt//mXpfksQYQQuNK8CCEg4srx0/gsQYQQEJpXhtIi4srxU/gsQZi25zXNG0NpEXHl+O58liBM2/OW5h1DaRFx5fiufJYgTNvzHs0NQ2kRceX4bnyWIEzbc4vmjqG0iLhyfBc+SxCm7blnxweG0hJXjqu4cgyl5eHxzC2X44ml+SxhCtP2fEQzwVBaxMPjmXseHs8syWcJU5i2Z4odEw2l5eHxzBQPj2cuxxNfzWcJX00z0cPjmTkeHs98JZ8lzOGzhCk0G6fZOM3GaTZOs3GajdNMdDmemONyPPEnmbZnCs0Ml+OJKZRSxJXjq/gsYQ7T9kylmelyPHHP5XhCxJXjd/ksQZi2x7Q995i2Z44dn3A5nrhnKC1x5biKK8dQWj7DZwnCtD3CtD1fRbOQobSIuHLM5bMEYdqepWgWNJQWEVeOqXyWIEzbsyTNwobSIuLK8RGfJQjT9ixNs4KhtIi4ctziswRh2p41aFYylBYRV463fJYgTNuzFs2KhtIi4srxHtP2rEmzsqG03GLanrUpILBhmo3TbNwuhID47++/WFqUd9xjasvSng9nhGZFUd4hxiblPb5wrEmzkijvEGOT8papLcIXjrVoVhDlHWJsUm4xtUX4wrEGzcKivEOMTcpHTG0RvnAsTbOgKO8QY5MylaktwheOJWkWEuUdYmxS5jK1RfjCsRTNAqK8Q4xNymeZ2iJ84VjCjk+I8o4pxibld5na4gvHlS8cprY8H87csn86MYdmpijvmGJsUr6KqS3i+XDmnufDmTk0M0R5x59iaksIgSmeD2em0kwU5R1zRHnHV3o+nJnj+XBmCs3GaTZOs3GajdNsnGbjNAsZm5SvtH86Mcf+6cQUmgmivGOOsUlZwv7pxBRKKXzhmELzgSjvEGOTMjYp94xNypL2Tyfu2T+dEL5wfGTHHVHeIcYmRYxNyp+0fzpxj6ktvnBc+cJhasstmhuivEOMTcp3Y2qL8IXjFs07orxDjE3Kd2Vqi/CF4z2aN6K8Q4xNyndnaovwheMtzStR3iHGJuWnMLVF+MLxmuaFUgoxNik/jaktQimF2PGLUgoRQmA9CvF8OLO4cEYpxZVSihACWimFCCHw04UQEEopNC9CCGxFCAHxP6ljTOR/ggguAAAAAElFTkSuQmCC";
