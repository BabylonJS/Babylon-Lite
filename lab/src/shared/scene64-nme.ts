/** Scene 64 — NME morph targets.
 *
 *  Adds a MorphTargetsBlock driving positionOutput into the WVP transform.
 *  One morph target with a uniform +Y delta is set at weight=1.0; the sphere
 *  renders translated upward. Flat-colour fragment so visual parity depends
 *  only on the morphed silhouette (no lighting math to diverge).
 *
 *  Graph:
 *    Vertex:
 *      position (attr) ─┐
 *                       ├─► MorphTargetsBlock ─► positionOutput
 *      normal   (attr) ─┘                     (normalOutput unused)
 *      positionOutput × WVP ─► VertexOutput
 *    Fragment:
 *      color uniform ─► FragmentOutput.rgb   (alpha defaults to 1.0)
 *
 *  Both BJS and Lite create the same sphere geometry, and the morph delta
 *  is uniform (same +Y offset for every vertex), so the rendered result is
 *  identical regardless of per-vertex indexing order inside either engine.
 */
export const SCENE64_NME_JSON = {
    tags: null,
    ignoreAlpha: false,
    maxSimultaneousLights: 4,
    mode: 0,
    forceAlphaBlending: false,
    id: "scene64nm",
    name: "Scene64NME",
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
            animationType: 0,
            isBoolean: false,
            matrixMode: 0,
            isConstant: false,
            convertToGammaSpace: false,
            convertToLinearSpace: false,
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
            animationType: 0,
            isBoolean: false,
            matrixMode: 0,
            isConstant: false,
            convertToGammaSpace: false,
            convertToLinearSpace: false,
        },
        // id=3 WorldViewProjection (mat4 system value)
        {
            customType: "BABYLON.InputBlock",
            id: 3,
            name: "worldViewProjection",
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 128,
            mode: 0,
            systemValue: 6,
            animationType: 0,
            isBoolean: false,
            matrixMode: 0,
            isConstant: false,
            convertToGammaSpace: false,
            convertToLinearSpace: false,
        },
        // id=4 diffuse color uniform (Color3, user-overridable)
        {
            customType: "BABYLON.InputBlock",
            id: 4,
            name: "color",
            target: 2,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 32,
            mode: 0,
            systemValue: null,
            animationType: 0,
            isBoolean: false,
            matrixMode: 0,
            isConstant: false,
            valueType: "BABYLON.Color3",
            value: [0.85, 0.35, 0.35],
            convertToGammaSpace: false,
            convertToLinearSpace: false,
        },
        // id=5 MorphTargetsBlock — position + normal in, positionOutput out
        {
            customType: "BABYLON.MorphTargetsBlock",
            id: 5,
            name: "Morph",
            target: 1,
            inputs: [
                { name: "position", inputName: "position", targetBlockId: 1, targetConnectionName: "output" },
                { name: "normal", inputName: "normal", targetBlockId: 2, targetConnectionName: "output" },
                { name: "tangent", inputName: "tangent" },
                { name: "uv", inputName: "uv" },
            ],
            outputs: [{ name: "positionOutput" }, { name: "normalOutput" }, { name: "tangentOutput" }, { name: "uvOutput" }],
        },
        // id=6 Transform morphedPosition × WVP → VertexOutput
        {
            customType: "BABYLON.TransformBlock",
            id: 6,
            name: "TransformWVP",
            target: 1,
            inputs: [
                { name: "vector", inputName: "vector", targetBlockId: 5, targetConnectionName: "positionOutput" },
                { name: "transform", inputName: "transform", targetBlockId: 3, targetConnectionName: "output" },
            ],
            outputs: [{ name: "output" }, { name: "xyz" }],
            complementZ: 0,
            complementW: 1,
        },
        // id=7 VertexOutput
        {
            customType: "BABYLON.VertexOutputBlock",
            id: 7,
            name: "VertexOutput",
            target: 1,
            inputs: [{ name: "vector", inputName: "vector", targetBlockId: 6, targetConnectionName: "output" }],
            outputs: [],
        },
        // id=8 FragmentOutput (rgb = color uniform)
        {
            customType: "BABYLON.FragmentOutputBlock",
            id: 8,
            name: "FragmentOutput",
            target: 2,
            inputs: [
                { name: "rgba", inputName: "rgba" },
                { name: "rgb", inputName: "rgb", targetBlockId: 4, targetConnectionName: "output" },
                { name: "a", inputName: "a" },
            ],
            outputs: [],
            convertToGammaSpace: false,
            convertToLinearSpace: false,
            useLogarithmicDepth: false,
        },
    ],
    outputNodes: [7, 8],
};

/** Uniform +Y morph offset applied to every vertex at weight=1.
 *  Kept as a named constant so BJS and Lite sides use the identical value. */
export const SCENE64_MORPH_DELTA_Y = 0.5;
/** Animation period in milliseconds for the morph weight cycle. */
export const SCENE64_MORPH_PERIOD_MS = 2000;
