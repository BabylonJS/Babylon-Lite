/** Scene 149 — generic geometry-impostor NodeMaterial graph.
 *
 *  ONE generic NME graph, instantiated once per original PowerPlant material
 *  (each instance only swaps the albedo `TextureBlock`'s bound texture). It has
 *  two fragment terminals:
 *
 *    • `FragmentOutputBlock`        — the normal scene-colour pass (flat albedo).
 *    • `GeometryTextureOutputBlock` — the geometry-renderer pass (the Lite
 *                                     analogue of BJS `PrePassOutputBlock`).
 *
 *  Graph:
 *    Vertex:
 *      position (attr) × WorldViewProjection ─► VertexOutput
 *      position (attr) × World               ─► worldPos   (vec4)
 *      normal   (attr) × World  (W=0)        ─► worldNormal(vec4)
 *      worldNormal     × View                ─► viewNormal (vec4)
 *    Fragment:
 *      albedo TextureBlock(uv = uv attr).rgb ─► FragmentOutput.rgb
 *      GeometryTextureOutput {
 *        worldPosition = worldPos,
 *        localPosition = position attr,
 *        worldNormal   = worldNormal,
 *        viewNormal    = viewNormal,
 *        reflectivity  = reflectivity (const Color3),
 *        albedo        = albedo.rgb
 *      }
 *
 *  Depth inputs (viewDepth / normalizedViewDepth / screenspaceDepth),
 *  irradiance and linearVelocity are intentionally left unconnected — the node
 *  pipeline derives them from worldPosition / clip-space per the engine
 *  defaults (see node-geometry-renderable.ts).
 */
export const SCENE149_NME_JSON = {
    tags: null,
    ignoreAlpha: false,
    maxSimultaneousLights: 4,
    mode: 0,
    forceAlphaBlending: false,
    id: "scene149nm",
    name: "Scene149NME",
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
    fogEnabled: true,
    pointSize: 1,
    zOffset: 0,
    zOffsetUnits: 0,
    pointsCloud: false,
    fillMode: 0,
    editorData: null,
    customBlocks: [],
    blocks: [
        // id=1 position attribute (vec3, attr)
        {
            customType: "BABYLON.InputBlock",
            id: 1,
            name: "position",
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 8,
            mode: 1,
            systemValue: null,
            isConstant: false,
        },
        // id=2 normal attribute (vec3, attr)
        {
            customType: "BABYLON.InputBlock",
            id: 2,
            name: "normal",
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 8,
            mode: 1,
            systemValue: null,
            isConstant: false,
        },
        // id=3 uv attribute (vec2, attr)
        {
            customType: "BABYLON.InputBlock",
            id: 3,
            name: "uv",
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 4,
            mode: 1,
            systemValue: null,
            isConstant: false,
        },
        // id=4 WorldViewProjection (mat4 system value 6)
        {
            customType: "BABYLON.InputBlock",
            id: 4,
            name: "worldViewProjection",
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 128,
            mode: 0,
            systemValue: 6,
            isConstant: false,
        },
        // id=5 World (mat4 system value 1)
        {
            customType: "BABYLON.InputBlock",
            id: 5,
            name: "world",
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 128,
            mode: 0,
            systemValue: 1,
            isConstant: false,
        },
        // id=6 View (mat4 system value 2)
        {
            customType: "BABYLON.InputBlock",
            id: 6,
            name: "view",
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 128,
            mode: 0,
            systemValue: 2,
            isConstant: false,
        },
        // id=7 reflectivity uniform (Color3 constant)
        {
            customType: "BABYLON.InputBlock",
            id: 7,
            name: "reflectivity",
            target: 2,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 32,
            mode: 0,
            systemValue: null,
            valueType: "BABYLON.Color3",
            value: [0.2, 0.2, 0.2],
            isConstant: false,
        },
        // id=8 Transform position × WVP → VertexOutput
        {
            customType: "BABYLON.TransformBlock",
            id: 8,
            name: "TransformWVP",
            target: 1,
            inputs: [
                { name: "vector", inputName: "vector", targetBlockId: 1, targetConnectionName: "output" },
                { name: "transform", inputName: "transform", targetBlockId: 4, targetConnectionName: "output" },
            ],
            outputs: [{ name: "output" }, { name: "xyz" }],
            complementZ: 0,
            complementW: 1,
        },
        // id=9 Transform position × World → worldPos
        {
            customType: "BABYLON.TransformBlock",
            id: 9,
            name: "TransformWorldPos",
            target: 1,
            inputs: [
                { name: "vector", inputName: "vector", targetBlockId: 1, targetConnectionName: "output" },
                { name: "transform", inputName: "transform", targetBlockId: 5, targetConnectionName: "output" },
            ],
            outputs: [{ name: "output" }, { name: "xyz" }],
            complementZ: 0,
            complementW: 1,
        },
        // id=10 Transform normal × World (W=0) → worldNormal
        {
            customType: "BABYLON.TransformBlock",
            id: 10,
            name: "TransformWorldNormal",
            target: 1,
            inputs: [
                { name: "vector", inputName: "vector", targetBlockId: 2, targetConnectionName: "output" },
                { name: "transform", inputName: "transform", targetBlockId: 5, targetConnectionName: "output" },
            ],
            outputs: [{ name: "output" }, { name: "xyz" }],
            complementZ: 0,
            complementW: 0,
        },
        // id=11 Transform worldNormal × View → viewNormal
        {
            customType: "BABYLON.TransformBlock",
            id: 11,
            name: "TransformViewNormal",
            target: 1,
            inputs: [
                { name: "vector", inputName: "vector", targetBlockId: 10, targetConnectionName: "output" },
                { name: "transform", inputName: "transform", targetBlockId: 6, targetConnectionName: "output" },
            ],
            outputs: [{ name: "output" }, { name: "xyz" }],
            complementZ: 0,
            complementW: 0,
        },
        // id=12 albedo TextureBlock (uv from uv attr)
        {
            customType: "BABYLON.TextureBlock",
            id: 12,
            name: "albedo",
            target: 3,
            inputs: [{ name: "uv", inputName: "uv", targetBlockId: 3, targetConnectionName: "output" }],
            outputs: [{ name: "rgba" }, { name: "rgb" }, { name: "r" }, { name: "g" }, { name: "b" }, { name: "a" }, { name: "level" }],
            convertToGammaSpace: false,
            convertToLinearSpace: false,
            fragmentOnly: false,
            disableLevelMultiplication: false,
        },
        // id=13 VertexOutput
        {
            customType: "BABYLON.VertexOutputBlock",
            id: 13,
            name: "VertexOutput",
            target: 1,
            inputs: [{ name: "vector", inputName: "vector", targetBlockId: 8, targetConnectionName: "output" }],
            outputs: [],
        },
        // id=14 FragmentOutput (rgb = albedo.rgb — flat albedo colour pass)
        {
            customType: "BABYLON.FragmentOutputBlock",
            id: 14,
            name: "FragmentOutput",
            target: 2,
            inputs: [
                { name: "rgba", inputName: "rgba" },
                { name: "rgb", inputName: "rgb", targetBlockId: 12, targetConnectionName: "rgb" },
                { name: "a", inputName: "a" },
            ],
            outputs: [],
            convertToGammaSpace: false,
            convertToLinearSpace: false,
            useLogarithmicDepth: false,
        },
        // id=15 GeometryTextureOutput (the geometry-renderer terminal)
        {
            customType: "BABYLON.GeometryTextureOutputBlock",
            id: 15,
            name: "GeometryTextureOutput",
            target: 2,
            inputs: [
                { name: "worldPosition", inputName: "worldPosition", targetBlockId: 9, targetConnectionName: "output" },
                { name: "localPosition", inputName: "localPosition", targetBlockId: 1, targetConnectionName: "output" },
                { name: "worldNormal", inputName: "worldNormal", targetBlockId: 10, targetConnectionName: "output" },
                { name: "viewNormal", inputName: "viewNormal", targetBlockId: 11, targetConnectionName: "output" },
                { name: "reflectivity", inputName: "reflectivity", targetBlockId: 7, targetConnectionName: "output" },
                { name: "albedo", inputName: "albedo", targetBlockId: 12, targetConnectionName: "rgb" },
            ],
            outputs: [],
        },
    ],
    outputNodes: [13, 14, 15],
};
