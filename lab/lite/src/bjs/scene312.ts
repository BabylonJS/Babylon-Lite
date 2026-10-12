import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphMeshBlendingTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/meshBlendingTask";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { MeshBlendingRadiusClass, PackMeshBlendingTag } from "@babylonjs/core/Meshes/meshBlendingTag";
import { MeshBlendDepthType, MeshBlendQuality } from "@babylonjs/core/PostProcesses/thinMeshBlendingPostProcess";
import { Scene } from "@babylonjs/core/scene";

const COLORS = [new Color3(0.9, 0.18, 0.2), new Color3(0.15, 0.72, 0.95), new Color3(0.2, 0.9, 0.4), new Color3(0.95, 0.62, 0.1)];

(async function () {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.useReverseDepthBuffer = true;
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.03, 0.035, 0.05, 1);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2, 10, Vector3.Zero(), scene);
    camera.minZ = 0.2;
    camera.maxZ = 50;
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    const updateOrtho = () => {
        const halfHeight = 3.2;
        const halfWidth = halfHeight * (engine.getRenderWidth() / engine.getRenderHeight());
        camera.orthoLeft = -halfWidth;
        camera.orthoRight = halfWidth;
        camera.orthoTop = halfHeight;
        camera.orthoBottom = -halfHeight;
    };
    updateOrtho();
    scene.activeCamera = camera;

    for (let index = 0; index < 4; index++) {
        const panel = MeshBuilder.CreatePlane(`panel-${index}`, { width: 2.5, height: 5.6 }, scene);
        panel.position.set(-3.75 + index * 2.5, 0, 0);
        const material = new StandardMaterial(`panel-material-${index}`, scene);
        material.diffuseColor = Color3.White();
        material.emissiveColor = COLORS[index]!;
        material.specularColor = Color3.Black();
        material.disableLighting = true;
        material.backFaceCulling = false;
        panel.material = material;
        panel.meshBlendingTag = PackMeshBlendingTag(index + 1, index as MeshBlendingRadiusClass);
    }

    const frameGraph = new FrameGraph(scene, true);
    scene.frameGraph = frameGraph;
    const color = frameGraph.textureManager.createRenderTargetTexture("scene312-color", {
        size: { width: 100, height: 100 },
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_HALF_FLOAT],
            formats: [Constants.TEXTUREFORMAT_RGBA],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["scene312-color"],
        },
    });
    const depth = frameGraph.textureManager.createRenderTargetTexture("scene312-depth", {
        size: { width: 100, height: 100 },
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["scene312-depth"],
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
        { type: Constants.PREPASS_SCREENSPACE_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RED },
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
    blend.depthTexture = geometry.geometryScreenDepthTexture;
    blend.camera = camera;
    blend.configure({
        quality: MeshBlendQuality.High,
        depthType: MeshBlendDepthType.Screen,
        radiusClasses: [
            { worldRadius: 0.08, minimumProjectedRadius: 2 },
            { worldRadius: 0.14, minimumProjectedRadius: 3 },
            { worldRadius: 0.22, minimumProjectedRadius: 4 },
            { worldRadius: 0.32, minimumProjectedRadius: 5 },
        ],
        slopeFactor: 1.6,
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
        updateOrtho();
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
