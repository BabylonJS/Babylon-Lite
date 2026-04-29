/** Scene 63 — NME directional lighting (Blinn-Phong).
 *
 *  Adds a single light to the minimal graph: world-space position + world
 *  normal feed a LightBlock whose `diffuseOutput` drives FragmentOutput.rgb.
 *  The scene adds one DirectionalLight; both BJS and Lite's NME loop over
 *  `scene.lights` in the shared lights UBO.
 *
 *  Graph:
 *    Vertex:
 *      position (attr) × WVP              ──► VertexOutput
 *      position (attr) × World  ──► worldPos (vec4)
 *      normal   (attr) × World  ──► worldNormal (vec4, complementW=0)
 *    Fragment:
 *      LightBlock(worldPosition=worldPos, worldNormal=worldNormal,
 *                 cameraPosition=sceneU.vEyePosition, diffuseColor=color)
 *      LightBlock.diffuseOutput ──► FragmentOutput.rgb  (alpha = 1.0 default)
 *
 *  `color` is a user-overridable Color3 uniform (defaults to warm orange).
 */
export const SCENE63_NME_JSON = {
    tags: null,
    ignoreAlpha: false,
    maxSimultaneousLights: 4,
    mode: 0,
    forceAlphaBlending: false,
    id: "scene63nm",
    name: "Scene63NME",
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
        // id=4 World (mat4 system value)
        {
            customType: "BABYLON.InputBlock",
            id: 4,
            name: "world",
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 128,
            mode: 0,
            systemValue: 1,
            animationType: 0,
            isBoolean: false,
            matrixMode: 0,
            isConstant: false,
            convertToGammaSpace: false,
            convertToLinearSpace: false,
        },
        // id=5 CameraPosition (vec3, system value 7)
        {
            customType: "BABYLON.InputBlock",
            id: 5,
            name: "cameraPosition",
            target: 2,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 8,
            mode: 0,
            systemValue: 7,
            animationType: 0,
            isBoolean: false,
            matrixMode: 0,
            isConstant: false,
            convertToGammaSpace: false,
            convertToLinearSpace: false,
        },
        // id=6 diffuse color uniform (Color3, user-overridable)
        {
            customType: "BABYLON.InputBlock",
            id: 6,
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
            value: [0.9, 0.45, 0.15],
            convertToGammaSpace: false,
            convertToLinearSpace: false,
        },
        // id=7 Transform position × WVP → VertexOutput
        {
            customType: "BABYLON.TransformBlock",
            id: 7,
            name: "TransformWVP",
            target: 1,
            inputs: [
                { name: "vector", inputName: "vector", targetBlockId: 1, targetConnectionName: "output" },
                { name: "transform", inputName: "transform", targetBlockId: 3, targetConnectionName: "output" },
            ],
            outputs: [{ name: "output" }, { name: "xyz" }],
            complementZ: 0,
            complementW: 1,
        },
        // id=8 Transform position × World → worldPos
        {
            customType: "BABYLON.TransformBlock",
            id: 8,
            name: "TransformWorldPos",
            target: 1,
            inputs: [
                { name: "vector", inputName: "vector", targetBlockId: 1, targetConnectionName: "output" },
                { name: "transform", inputName: "transform", targetBlockId: 4, targetConnectionName: "output" },
            ],
            outputs: [{ name: "output" }, { name: "xyz" }],
            complementZ: 0,
            complementW: 1,
        },
        // id=9 Transform normal × World (complementW=0 for directions)
        {
            customType: "BABYLON.TransformBlock",
            id: 9,
            name: "TransformWorldNormal",
            target: 1,
            inputs: [
                { name: "vector", inputName: "vector", targetBlockId: 2, targetConnectionName: "output" },
                { name: "transform", inputName: "transform", targetBlockId: 4, targetConnectionName: "output" },
            ],
            outputs: [{ name: "output" }, { name: "xyz" }],
            complementZ: 0,
            complementW: 0,
        },
        // id=10 VertexOutput
        {
            customType: "BABYLON.VertexOutputBlock",
            id: 10,
            name: "VertexOutput",
            target: 1,
            inputs: [{ name: "vector", inputName: "vector", targetBlockId: 7, targetConnectionName: "output" }],
            outputs: [],
        },
        // id=11 LightBlock
        {
            customType: "BABYLON.LightBlock",
            id: 11,
            name: "Light",
            target: 2,
            inputs: [
                { name: "worldPosition", inputName: "worldPosition", targetBlockId: 8, targetConnectionName: "output" },
                { name: "worldNormal", inputName: "worldNormal", targetBlockId: 9, targetConnectionName: "output" },
                { name: "cameraPosition", inputName: "cameraPosition", targetBlockId: 5, targetConnectionName: "output" },
                { name: "diffuseColor", inputName: "diffuseColor", targetBlockId: 6, targetConnectionName: "output" },
                { name: "specularColor", inputName: "specularColor" },
                { name: "glossiness", inputName: "glossiness" },
                { name: "glossPower", inputName: "glossPower" },
                { name: "view", inputName: "view" },
            ],
            outputs: [{ name: "diffuseOutput" }, { name: "specularOutput" }, { name: "shadow" }],
        },
        // id=12 FragmentOutput (rgb = LightBlock.diffuseOutput, alpha defaults to 1)
        {
            customType: "BABYLON.FragmentOutputBlock",
            id: 12,
            name: "FragmentOutput",
            target: 2,
            inputs: [
                { name: "rgba", inputName: "rgba" },
                { name: "rgb", inputName: "rgb", targetBlockId: 11, targetConnectionName: "diffuseOutput" },
                { name: "a", inputName: "a" },
            ],
            outputs: [],
            convertToGammaSpace: false,
            convertToLinearSpace: false,
            useLogarithmicDepth: false,
        },
    ],
    outputNodes: [10, 12],
};
