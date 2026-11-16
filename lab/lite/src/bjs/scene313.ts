import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphMeshBlendingTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/meshBlendingTask";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Material } from "@babylonjs/core/Materials/material";
import { PBRMetallicRoughnessMaterial } from "@babylonjs/core/Materials/PBR/pbrMetallicRoughnessMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { MeshBlendingRadiusClass, PackMeshBlendingTag } from "@babylonjs/core/Meshes/meshBlendingTag";
import { MeshBlendDebugMode } from "@babylonjs/core/PostProcesses/thinMeshBlendingPostProcess";
import { Scene } from "@babylonjs/core/scene";

const TEXTURE_SIZE = 64;

function createCutoutPixels(): Uint8Array {
    const pixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
    for (let y = 0; y < TEXTURE_SIZE; y++) {
        for (let x = 0; x < TEXTURE_SIZE; x++) {
            const offset = (y * TEXTURE_SIZE + x) * 4;
            const cellX = (x % 16) - 7.5;
            const cellY = (y % 16) - 7.5;
            const opaque = cellX * cellX + cellY * cellY < 34 || ((x >> 3) + (y >> 3)) % 4 === 0;
            pixels[offset] = 245;
            pixels[offset + 1] = 205 - ((x >> 3) % 2) * 85;
            pixels[offset + 2] = 55 + ((y >> 3) % 2) * 150;
            pixels[offset + 3] = opaque ? 255 : 0;
        }
    }
    return pixels;
}

(async function () {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.useReverseDepthBuffer = true;
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.025, 0.03, 0.045, 1);
    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2, 7, Vector3.Zero(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 40;
    scene.activeCamera = camera;
    new HemisphericLight("light", new Vector3(0.15, 1, -0.2), scene);

    const texture = RawTexture.CreateRGBATexture(createCutoutPixels(), TEXTURE_SIZE, TEXTURE_SIZE, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    texture.hasAlpha = true;
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;

    const standardBack = MeshBuilder.CreateBox("standard-back", { size: 3.25 }, scene);
    standardBack.scaling.set(1, 1, 0.22);
    standardBack.position.set(-2.2, 0, 0.55);
    const standardBackMaterial = new StandardMaterial("standard-back-material", scene);
    standardBackMaterial.diffuseColor = new Color3(0.1, 0.55, 0.95);
    standardBackMaterial.specularColor = Color3.Black();
    standardBack.material = standardBackMaterial;
    standardBack.meshBlendingTag = PackMeshBlendingTag(1, MeshBlendingRadiusClass.Medium);

    const standardCutout = MeshBuilder.CreatePlane("standard-cutout", { width: 3.25, height: 3.25 }, scene);
    standardCutout.position.set(-2.2, 0, -0.35);
    const standardCutoutMaterial = new StandardMaterial("standard-cutout-material", scene);
    standardCutoutMaterial.diffuseTexture = texture;
    standardCutoutMaterial.useAlphaFromDiffuseTexture = true;
    standardCutoutMaterial.diffuseColor = Color3.White();
    standardCutoutMaterial.emissiveColor = new Color3(0.08, 0.08, 0.08);
    standardCutoutMaterial.transparencyMode = Material.MATERIAL_ALPHATEST;
    standardCutoutMaterial.alphaCutOff = 0.5;
    standardCutoutMaterial.backFaceCulling = false;
    standardCutout.material = standardCutoutMaterial;
    standardCutout.meshBlendingTag = PackMeshBlendingTag(2, MeshBlendingRadiusClass.Large);

    const pbrBack = MeshBuilder.CreateBox("pbr-back", { size: 3.25 }, scene);
    pbrBack.scaling.set(1, 1, 0.22);
    pbrBack.position.set(2.2, 0, 0.55);
    const pbrBackMaterial = new StandardMaterial("pbr-back-material", scene);
    pbrBackMaterial.diffuseColor = new Color3(0.15, 0.9, 0.35);
    pbrBackMaterial.specularColor = Color3.Black();
    pbrBack.material = pbrBackMaterial;
    pbrBack.meshBlendingTag = PackMeshBlendingTag(3, MeshBlendingRadiusClass.Medium);

    const pbrCutout = MeshBuilder.CreatePlane("pbr-cutout", { width: 3.25, height: 3.25 }, scene);
    pbrCutout.position.set(2.2, 0, -0.35);
    const pbrCutoutMaterial = new PBRMetallicRoughnessMaterial("pbr-cutout-material", scene);
    pbrCutoutMaterial.baseTexture = texture;
    pbrCutoutMaterial.baseColor = Color3.White();
    pbrCutoutMaterial.metallic = 0;
    pbrCutoutMaterial.roughness = 0.82;
    pbrCutoutMaterial.transparencyMode = Material.MATERIAL_ALPHATEST;
    pbrCutoutMaterial.alphaCutOff = 0.5;
    pbrCutoutMaterial.backFaceCulling = false;
    pbrCutout.material = pbrCutoutMaterial;
    pbrCutout.meshBlendingTag = PackMeshBlendingTag(4, MeshBlendingRadiusClass.ExtraLarge);

    const frameGraph = new FrameGraph(scene, true);
    scene.frameGraph = frameGraph;
    const color = frameGraph.textureManager.createRenderTargetTexture("scene313-color", {
        size: { width: 100, height: 100 },
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_HALF_FLOAT],
            formats: [Constants.TEXTUREFORMAT_RGBA],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["scene313-color"],
        },
    });
    const depth = frameGraph.textureManager.createRenderTargetTexture("scene313-depth", {
        size: { width: 100, height: 100 },
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["scene313-depth"],
        },
    });
    const clear = new FrameGraphClearTextureTask("clear", frameGraph);
    clear.color = scene.clearColor;
    clear.clearColor = true;
    clear.clearDepth = true;
    clear.targetTexture = color;
    clear.depthTexture = depth;
    frameGraph.addTask(clear);
    const geometry = new FrameGraphGeometryRendererTask("geometry", frameGraph, scene);
    geometry.depthTexture = clear.outputDepthTexture;
    geometry.camera = camera;
    geometry.objectList = { meshes: scene.meshes, particleSystems: [] };
    geometry.samples = 1;
    geometry.textureDescriptions = [
        { type: Constants.PREPASS_MESH_BLEND_TAG_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RED_INTEGER },
        { type: Constants.PREPASS_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RED },
    ];
    frameGraph.addTask(geometry);
    const render = new FrameGraphObjectRendererTask("render", frameGraph, scene);
    render.targetTexture = clear.outputTexture;
    render.depthTexture = geometry.outputDepthTexture;
    render.camera = camera;
    render.objectList = { meshes: scene.meshes, particleSystems: [] };
    frameGraph.addTask(render);
    const blend = new FrameGraphMeshBlendingTask("mesh-blend", frameGraph);
    blend.sourceTexture = render.outputTexture;
    blend.meshBlendTagTexture = geometry.geometryMeshBlendTagTexture;
    blend.depthTexture = geometry.geometryViewDepthTexture;
    blend.camera = camera;
    blend.debugMode = MeshBlendDebugMode.PackedTag;
    frameGraph.addTask(blend);
    const output = new FrameGraphCopyToBackbufferColorTask("output", frameGraph);
    output.sourceTexture = blend.outputTexture;
    frameGraph.addTask(output);
    frameGraph.optimizeTextureAllocation = false;
    await frameGraph.buildAsync();
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", async () => {
        engine.resize();
        await frameGraph.buildAsync();
    });
    for (let i = 0; i < 8; i++) {
        await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    }
    canvas.dataset.ready = "true";
})().catch((error: unknown) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
});
