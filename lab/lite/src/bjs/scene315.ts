import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphMeshBlendingTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/meshBlendingTask";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBlendingRadiusClass, PackMeshBlendingTag } from "@babylonjs/core/Meshes/meshBlendingTag";
import { MeshBlendDepthType, MeshBlendQuality } from "@babylonjs/core/PostProcesses/thinMeshBlendingPostProcess";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

const ASSET_ROOT = "https://assets.babylonjs.com/meshes/MeshBlending/";
const ASSET_FILE = "coastalCliff.glb";
const ENVIRONMENT_URL = "https://playground.babylonjs.com/textures/country.env";

(async function () {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.useReverseDepthBuffer = true;
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.025, 0.035, 0.045, 1);
    scene.environmentTexture = CubeTexture.CreateFromPrefilteredData(ENVIRONMENT_URL, scene);
    scene.environmentIntensity = 1;
    scene.imageProcessingConfiguration.isEnabled = false;

    const result = await SceneLoader.ImportMeshAsync("", ASSET_ROOT, ASSET_FILE, scene);
    const renderMeshes = result.meshes.filter((mesh) => mesh.getTotalVertices() > 0 && mesh.material);
    if (!renderMeshes.some((mesh) => mesh.name === "P0061_primitive0")) {
        throw new Error("The P0061_primitive0 coastal-cliff mesh was not found.");
    }
    for (let index = 0; index < renderMeshes.length; index++) {
        const mesh = renderMeshes[index]!;
        mesh.meshBlendingTag = mesh.name === "P0078_primitive0" || mesh.name === "P0079_primitive0" ? 0 : PackMeshBlendingTag((index % 63) + 1, MeshBlendingRadiusClass.Small);
    }

    const camera = new FreeCamera("camera", new Vector3(19.196982408059775, 6.201319223798063, -18.734448534771463), scene);
    camera.setTarget(new Vector3(23.34427328356007, -11.02970061387117, 58.197432388998195));
    camera.minZ = 0.01;
    camera.maxZ = 2000;
    scene.activeCamera = camera;

    const frameGraph = new FrameGraph(scene, true);
    scene.frameGraph = frameGraph;
    const color = frameGraph.textureManager.createRenderTargetTexture("scene315-color", {
        size: { width: 100, height: 100 },
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_RGBA],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["scene315-color"],
        },
    });
    const depth = frameGraph.textureManager.createRenderTargetTexture("scene315-depth", {
        size: { width: 100, height: 100 },
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["scene315-depth"],
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
    geometry.objectList = { meshes: renderMeshes, particleSystems: [] };
    geometry.samples = 1;
    geometry.renderTransparentMeshes = false;
    geometry.textureDescriptions = [
        { type: Constants.PREPASS_MESH_BLEND_TAG_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RED_INTEGER },
        { type: Constants.PREPASS_SCREENSPACE_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RED },
        { type: Constants.PREPASS_ALBEDO_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA },
    ];
    frameGraph.addTask(geometry);
    const render = new FrameGraphObjectRendererTask("render", frameGraph, scene);
    render.targetTexture = clear.outputTexture;
    render.depthTexture = geometry.outputDepthTexture;
    render.camera = camera;
    render.objectList = { meshes: renderMeshes, particleSystems: [] };
    render.renderTransparentMeshes = false;
    frameGraph.addTask(render);
    const blend = new FrameGraphMeshBlendingTask("mesh-blend", frameGraph);
    blend.sourceTexture = render.outputTexture;
    blend.meshBlendTagTexture = geometry.geometryMeshBlendTagTexture;
    blend.depthTexture = geometry.geometryScreenDepthTexture;
    blend.baseColorTexture = geometry.geometryAlbedoTexture;
    blend.camera = camera;
    blend.configure({
        quality: MeshBlendQuality.Medium,
        depthType: MeshBlendDepthType.Screen,
        radiusClasses: [
            { worldRadius: 0.2759, minimumProjectedRadius: 1.5 },
            { worldRadius: 0.5518, minimumProjectedRadius: 3 },
            { worldRadius: 1.1035, minimumProjectedRadius: 3 },
            { worldRadius: 2.2071, minimumProjectedRadius: 5 },
        ],
        slopeFactor: 2,
    });
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
    for (let i = 0; i < 15; i++) {
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
