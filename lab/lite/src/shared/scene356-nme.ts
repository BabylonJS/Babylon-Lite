// Scene 356 — NME graphs. One NodeMaterial connects its FragmentOutput `glow` input (Babylon's additionalColor) and must
// render through its own shader in the glow map, vertex graph included; the other has no glow input and only occludes.

type NmeInput = {
    name: string;
    inputName: string;
    displayName: string;
    targetBlockId?: number;
    targetConnectionName?: string;
    isExposedOnFrame: boolean;
    exposedPortPosition: number;
};

type NmeBlock = {
    customType: string;
    id: number;
    name: string;
    comments: string;
    target: number;
    inputs: NmeInput[];
    outputs: { name: string }[];
    [key: string]: unknown;
};

type Port = { id: number; output: string };

const VERTEX = 1;
const FRAGMENT = 2;
const NEUTRAL = 4;
const FLOAT = 1;
const VECTOR2 = 4;
const VECTOR3 = 8;
const COLOR3 = 32;
const MATRIX = 128;
const WORLD = 1;
const VIEW_PROJECTION = 4;
const FRACT = 14;

function createGraph(id: string, name: string, build: (graph: ReturnType<typeof graphBuilder>) => readonly number[]): Record<string, unknown> {
    const graph = graphBuilder();
    const outputNodes = build(graph);
    return {
        tags: null,
        ignoreAlpha: false,
        maxSimultaneousLights: 4,
        mode: 0,
        forceAlphaBlending: false,
        id,
        name,
        customType: "BABYLON.NodeMaterial",
        checkReadyOnEveryCall: false,
        checkReadyOnlyOnce: false,
        state: "",
        alpha: 1,
        // Double-sided: Babylon.js culls the front faces of procedural meshes under right-handed NodeMaterials, unlike
        // its Standard materials and Lite. The right-handed twin (scene 358) must not depend on that divergence.
        backFaceCulling: false,
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
        blocks: graph.blocks,
        outputNodes,
    };
}

function graphBuilder() {
    let nextId = 1;
    const blocks: NmeBlock[] = [];
    const input = (name: string, source?: Port): NmeInput => ({
        name,
        inputName: name,
        displayName: name.trim(),
        ...(source ? { targetBlockId: source.id, targetConnectionName: source.output } : {}),
        isExposedOnFrame: true,
        exposedPortPosition: -1,
    });
    const block = (className: string, name: string, target: number, inputs: NmeInput[], outputs: string[], extra: Record<string, unknown> = {}): number => {
        const id = nextId++;
        blocks.push({ customType: `BABYLON.${className}`, id, name, comments: "", target, inputs, outputs: outputs.map((output) => ({ name: output })), ...extra });
        return id;
    };
    const value = (name: string, type: number, data: number | readonly number[] | null, mode = 0, systemValue: number | null = null): Port => {
        const valueType = type === FLOAT ? "number" : type === COLOR3 ? "BABYLON.Color3" : type === VECTOR2 ? "BABYLON.Vector2" : "BABYLON.Vector3";
        const id = block("InputBlock", name, mode === 1 ? VERTEX : NEUTRAL, [], ["output"], {
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
            ...(data === null ? {} : { valueType, value: data }),
        });
        return { id, output: "output" };
    };
    const transform = (name: string, vector: Port, matrix: Port): Port => ({
        id: block("TransformBlock", name, VERTEX, [input("vector", vector), input("transform", matrix)], ["output", "xyz"], { complementZ: 0, complementW: 1 }),
        output: "output",
    });
    const project = (position: Port): number => {
        const world = transform("WorldPosition", position, value("world", MATRIX, null, 0, WORLD));
        const clip = transform("ClipPosition", world, value("viewProjection", MATRIX, null, 0, VIEW_PROJECTION));
        return block("VertexOutputBlock", "VertexOutput", VERTEX, [input("vector", clip)], []);
    };
    const output = (rgb: Port, glow?: Port): number =>
        block("FragmentOutputBlock", "FragmentOutput", FRAGMENT, [input("rgba"), input("rgb", rgb), input("a"), input("glow", glow)], [], {
            convertToGammaSpace: false,
            convertToLinearSpace: false,
            useLogarithmicDepth: false,
        });
    return { blocks, input, block, value, project, output };
}

/** Stretched in its vertex graph and glowing in horizontal stripes: only its own shader reproduces both. */
export const SCENE356_GLOW_NME_JSON = createGraph("scene356glow", "Scene356NodeGlow", (graph) => {
    const position = graph.value("position", VECTOR3, null, 1);
    const stretch = graph.value("stretch", VECTOR3, [1, 1.5, 1]);
    const stretched = { id: graph.block("MultiplyBlock", "Stretch", NEUTRAL, [graph.input("left", position), graph.input("right", stretch)], ["output"]), output: "output" };
    const vertex = graph.project(stretched);
    const uv = graph.value("uv", VECTOR2, null, 1);
    const split = graph.block("VectorSplitterBlock", "SplitUV", NEUTRAL, [graph.input("xy ", uv)], ["xyz", "xy", "zw", "x", "y", "z", "w"]);
    const bands = {
        id: graph.block("MultiplyBlock", "Bands", NEUTRAL, [graph.input("left", { id: split, output: "y" }), graph.input("right", graph.value("bandCount", FLOAT, 3))], ["output"]),
        output: "output",
    };
    const phase = { id: graph.block("TrigonometryBlock", "BandPhase", NEUTRAL, [graph.input("input", bands)], ["output"], { operation: FRACT }), output: "output" };
    const stripe = {
        id: graph.block("StepBlock", "Stripe", NEUTRAL, [graph.input("value", phase), graph.input("edge", graph.value("stripeEdge", FLOAT, 0.5))], ["output"]),
        output: "output",
    };
    const glow = {
        id: graph.block("ScaleBlock", "GlowStripes", NEUTRAL, [graph.input("input", graph.value("glowColor", COLOR3, [0.2, 1, 0.35])), graph.input("factor", stripe)], ["output"]),
        output: "output",
    };
    return [vertex, graph.output(graph.value("baseColor", COLOR3, [0.07, 0.08, 0.1]), glow)];
});

/** Bright but without a glow input: it must render in the neutral color and occlude the stripes behind it. */
export const SCENE356_PLAIN_NME_JSON = createGraph("scene356plain", "Scene356NodePlain", (graph) => {
    const vertex = graph.project(graph.value("position", VECTOR3, null, 1));
    return [vertex, graph.output(graph.value("baseColor", COLOR3, [1, 0.82, 0.25]))];
});
