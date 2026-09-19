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
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/core/Meshes/instancedMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { MeshBlendingRadiusClass, PackMeshBlendingTag } from "@babylonjs/core/Meshes/meshBlendingTag";
import { MeshBlendQuality } from "@babylonjs/core/PostProcesses/thinMeshBlendingPostProcess";
import { Scene } from "@babylonjs/core/scene";

(async function () {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.useReverseDepthBuffer = true;
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.025, 0.04, 1);
    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2, 7, Vector3.Zero(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 60;
    scene.activeCamera = camera;
    new HemisphericLight("light", new Vector3(0.2, 1, -0.25), scene);
    const createMaterial = (name: string, color: Color3) => {
        const value = new StandardMaterial(name, scene);
        value.diffuseColor = Color3.White();
        value.emissiveColor = color;
        value.specularColor = Color3.Black();
        value.disableLighting = true;
        return value;
    };

    const junctionLeft = MeshBuilder.CreateSphere("junction-left", { diameter: 2.3, segments: 24 }, scene);
    junctionLeft.position.set(-0.8, 1.25, 0);
    junctionLeft.material = createMaterial("junction-left-material", new Color3(0.95, 0.16, 0.18));
    junctionLeft.meshBlendingTag = PackMeshBlendingTag(1, MeshBlendingRadiusClass.ExtraLarge);
    const junctionRight = MeshBuilder.CreateSphere("junction-right", { diameter: 2.3, segments: 24 }, scene);
    junctionRight.position.set(0.8, 1.25, 0);
    junctionRight.material = createMaterial("junction-right-material", new Color3(0.08, 0.58, 1));
    junctionRight.meshBlendingTag = PackMeshBlendingTag(2, MeshBlendingRadiusClass.ExtraLarge);
    const junctionCenter = MeshBuilder.CreateBox("junction-center", { size: 1.75 }, scene);
    junctionCenter.position.set(0, 1.25, -0.35);
    junctionCenter.rotation.z = Math.PI / 4;
    junctionCenter.material = createMaterial("junction-center-material", new Color3(0.16, 0.95, 0.32));
    junctionCenter.meshBlendingTag = PackMeshBlendingTag(3, MeshBlendingRadiusClass.Large);

    const fallbackHost = MeshBuilder.CreateBox("fallback-host", { size: 1.75 }, scene);
    fallbackHost.position.set(-4.25, -1.45, 0.2);
    fallbackHost.material = createMaterial("fallback-host-material", new Color3(0.16, 0.55, 0.95));
    fallbackHost.meshBlendingTag = PackMeshBlendingTag(4, MeshBlendingRadiusClass.ExtraLarge);
    const tinyTarget = MeshBuilder.CreateSphere("tiny-target", { diameter: 0.48, segments: 16 }, scene);
    tinyTarget.position.set(-3.55, -1.45, -0.55);
    tinyTarget.material = createMaterial("tiny-target-material", new Color3(1, 0.55, 0.06));
    tinyTarget.meshBlendingTag = PackMeshBlendingTag(5, MeshBlendingRadiusClass.Small);

    const continuationHost = MeshBuilder.CreateSphere("continuation-host", { diameter: 1.9, segments: 24 }, scene);
    continuationHost.position.set(-0.9, -1.55, 0.2);
    continuationHost.material = createMaterial("continuation-host-material", new Color3(0.8, 0.16, 0.86));
    continuationHost.meshBlendingTag = PackMeshBlendingTag(6, MeshBlendingRadiusClass.Large);
    const continuationSliver = MeshBuilder.CreateBox("continuation-sliver", { size: 1 }, scene);
    continuationSliver.scaling.set(0.16, 1.15, 0.35);
    continuationSliver.position.set(-0.05, -1.55, -0.5);
    continuationSliver.rotation.z = 0.35;
    continuationSliver.material = createMaterial("continuation-sliver-material", new Color3(0.95, 0.9, 0.12));
    continuationSliver.meshBlendingTag = PackMeshBlendingTag(7, MeshBlendingRadiusClass.Medium);

    const source = MeshBuilder.CreateSphere("instance-source", { diameter: 0.9, segments: 18 }, scene);
    source.position.set(2.1, -1.55, -0.35);
    source.material = createMaterial("instance-source-material", new Color3(0.1, 0.9, 0.82));
    source.meshBlendingTag = PackMeshBlendingTag(10, MeshBlendingRadiusClass.Large);
    const instance = source.createInstance("regular-instance");
    instance.position.set(3.75, -1.55, -0.35);
    for (const x of [2.45, 4.1]) {
        const contact = MeshBuilder.CreateBox(`instance-contact-${x}`, { size: 1 }, scene);
        contact.position.set(x, -1.55, 0.05);
        contact.material = createMaterial(`instance-contact-material-${x}`, new Color3(0.95, 0.34, 0.08));
        contact.meshBlendingTag = PackMeshBlendingTag(11, MeshBlendingRadiusClass.Medium);
    }

    const frameGraph = new FrameGraph(scene, true);
    scene.frameGraph = frameGraph;
    const color = frameGraph.textureManager.createRenderTargetTexture("scene314-color", {
        size: { width: 100, height: 100 },
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_HALF_FLOAT],
            formats: [Constants.TEXTUREFORMAT_RGBA],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["scene314-color"],
        },
    });
    const depth = frameGraph.textureManager.createRenderTargetTexture("scene314-depth", {
        size: { width: 100, height: 100 },
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["scene314-depth"],
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
    blend.configure({
        quality: MeshBlendQuality.Cinematic,
        radiusClasses: [
            { worldRadius: 0.12, minimumProjectedRadius: 2 },
            { worldRadius: 0.2, minimumProjectedRadius: 3 },
            { worldRadius: 0.32, minimumProjectedRadius: 4 },
            { worldRadius: 0.48, minimumProjectedRadius: 6 },
        ],
        slopeFactor: 1.25,
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
    for (let i = 0; i < 10; i++) {
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
