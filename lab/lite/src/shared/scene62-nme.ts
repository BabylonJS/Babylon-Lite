/** Scene 62 — NME diffuse texture.
 *
 *  Adds a 2D texture sample to the minimal graph: UV attribute feeds a
 *  TextureBlock whose `rgba` output drives FragmentOutput. This proves
 *  texture+sampler BGL slot allocation, UV varying bridging, and
 *  `NodeInputHandle.texture` pass-through.
 *
 *  Graph:
 *    Vertex:   position ──► Transform × worldViewProjection ──► VertexOutput
 *    Fragment: uv (attr) ──► TextureBlock.uv
 *              TextureBlock.rgba ──► FragmentOutput.rgba
 *
 *  The TextureBlock's serialized `texture` is null (BJS default when the
 *  editor has no image hooked up); both BJS and Lite inject the same
 *  image URL programmatically after parse so parity remains bit-wise.
 */
export const SCENE62_NME_JSON = {
    tags: null,
    ignoreAlpha: false,
    maxSimultaneousLights: 4,
    mode: 0,
    forceAlphaBlending: false,
    id: "scene62nm",
    name: "Scene62NME",
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
        // id=1 position attribute
        {
            customType: "BABYLON.InputBlock",
            id: 1,
            name: "position",
            comments: "",
            visibleInInspector: false,
            visibleOnFrame: false,
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 8,
            mode: 1,
            systemValue: null,
            animationType: 0,
            min: 0,
            max: 0,
            isBoolean: false,
            matrixMode: 0,
            isConstant: false,
            groupInInspector: "",
            convertToGammaSpace: false,
            convertToLinearSpace: false,
        },
        // id=2 worldViewProjection (mat4 system value)
        {
            customType: "BABYLON.InputBlock",
            id: 2,
            name: "worldViewProjection",
            comments: "",
            visibleInInspector: false,
            visibleOnFrame: false,
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 128,
            mode: 0,
            systemValue: 6,
            animationType: 0,
            min: 0,
            max: 0,
            isBoolean: false,
            matrixMode: 0,
            isConstant: false,
            groupInInspector: "",
            convertToGammaSpace: false,
            convertToLinearSpace: false,
        },
        // id=3 TransformBlock
        {
            customType: "BABYLON.TransformBlock",
            id: 3,
            name: "Transform",
            comments: "",
            visibleInInspector: false,
            visibleOnFrame: false,
            target: 1,
            inputs: [
                { name: "vector", inputName: "vector", displayName: "vector", targetBlockId: 1, targetConnectionName: "output", isExposedOnFrame: true, exposedPortPosition: -1 },
                { name: "transform", inputName: "transform", displayName: "transform", targetBlockId: 2, targetConnectionName: "output", isExposedOnFrame: true, exposedPortPosition: -1 },
            ],
            outputs: [{ name: "output" }, { name: "xyz" }],
            complementZ: 0,
            complementW: 1,
        },
        // id=4 VertexOutput
        {
            customType: "BABYLON.VertexOutputBlock",
            id: 4,
            name: "VertexOutput",
            comments: "",
            visibleInInspector: false,
            visibleOnFrame: false,
            target: 1,
            inputs: [{ name: "vector", inputName: "vector", displayName: "vector", targetBlockId: 3, targetConnectionName: "output", isExposedOnFrame: true, exposedPortPosition: -1 }],
            outputs: [],
        },
        // id=5 uv attribute (vec2)
        {
            customType: "BABYLON.InputBlock",
            id: 5,
            name: "uv",
            comments: "",
            visibleInInspector: false,
            visibleOnFrame: false,
            target: 1,
            inputs: [],
            outputs: [{ name: "output" }],
            type: 4,
            mode: 1,
            systemValue: null,
            animationType: 0,
            min: 0,
            max: 0,
            isBoolean: false,
            matrixMode: 0,
            isConstant: false,
            groupInInspector: "",
            convertToGammaSpace: false,
            convertToLinearSpace: false,
        },
        // id=6 TextureBlock (diffuse)
        {
            customType: "BABYLON.TextureBlock",
            id: 6,
            name: "diffuse",
            comments: "",
            visibleInInspector: false,
            visibleOnFrame: false,
            target: 3,
            inputs: [
                { name: "uv", inputName: "uv", displayName: "uv", targetBlockId: 5, targetConnectionName: "output", isExposedOnFrame: true, exposedPortPosition: -1 },
                { name: "source", inputName: "source", displayName: "source", isExposedOnFrame: true, exposedPortPosition: -1 },
                { name: "layer", inputName: "layer", displayName: "layer", isExposedOnFrame: true, exposedPortPosition: -1 },
                { name: "lod", inputName: "lod", displayName: "lod", isExposedOnFrame: true, exposedPortPosition: -1 },
            ],
            outputs: [
                { name: "rgba" },
                { name: "rgb" },
                { name: "r" },
                { name: "g" },
                { name: "b" },
                { name: "a" },
                { name: "level" },
            ],
            convertToGammaSpace: false,
            convertToLinearSpace: false,
            disableLevelMultiplication: false,
            texture: null,
        },
        // id=7 FragmentOutput (rgba = diffuse.rgba)
        {
            customType: "BABYLON.FragmentOutputBlock",
            id: 7,
            name: "FragmentOutput",
            comments: "",
            visibleInInspector: false,
            visibleOnFrame: false,
            target: 2,
            inputs: [
                { name: "rgba", inputName: "rgba", displayName: "rgba", targetBlockId: 6, targetConnectionName: "rgba", isExposedOnFrame: true, exposedPortPosition: -1 },
                { name: "rgb", inputName: "rgb", displayName: "rgb", isExposedOnFrame: true, exposedPortPosition: -1 },
                { name: "a", inputName: "a", displayName: "a", isExposedOnFrame: true, exposedPortPosition: -1 },
            ],
            outputs: [],
            convertToGammaSpace: false,
            convertToLinearSpace: false,
            useLogarithmicDepth: false,
        },
    ],
    outputNodes: [4, 7],
};

export const SCENE62_TEXTURE_URL = "https://playground.babylonjs.com/textures/crate.png";
