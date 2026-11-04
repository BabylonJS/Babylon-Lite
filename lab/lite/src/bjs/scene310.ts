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
import { PBRMetallicRoughnessMaterial } from "@babylonjs/core/Materials/PBR/pbrMetallicRoughnessMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { MeshBlendingRadiusClass, PackMeshBlendingTag } from "@babylonjs/core/Meshes/meshBlendingTag";
import { Scene } from "@babylonjs/core/scene";

const COLORS = [new Color3(1.15, 0.18, 0.08), new Color3(0.08, 0.55, 1.1), new Color3(0.18, 1, 0.28), new Color3(1.1, 0.55, 0.05)];

(async function () {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.useReverseDepthBuffer = true;
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.025, 0.035, 0.055, 1);
    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2, 9.5, new Vector3(0, -0.1, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;
    scene.activeCamera = camera;
    new HemisphericLight("light", new Vector3(0.2, 1, -0.3), scene).intensity = 1.1;

    const xs = [-3.9, -1.3, 1.3, 3.9];
    for (let i = 0; i < xs.length; i++) {
        const sphere = MeshBuilder.CreateSphere(`sphere-${i}`, { diameter: 2.6, segments: 24 }, scene);
        sphere.position.set(xs[i]! - 0.48, 1.05, -0.1);
        const standard = new StandardMaterial(`standard-${i}`, scene);
        standard.diffuseColor = COLORS[i]!;
        standard.emissiveColor = COLORS[i]!.scale(0.08);
        standard.specularColor = new Color3(0.08, 0.08, 0.08);
        sphere.material = standard;
        sphere.meshBlendingTag = PackMeshBlendingTag(1 + i * 2, i as MeshBlendingRadiusClass);

        const box = MeshBuilder.CreateBox(`box-${i}`, { size: 2.35 }, scene);
        box.position.set(xs[i]! + 0.48, 1.05, 0.1);
        box.rotation.y = 0.25;
        const pbr = new PBRMetallicRoughnessMaterial(`pbr-${i}`, scene);
        pbr.baseColor = COLORS[(i + 1) % COLORS.length]!;
        pbr.metallic = 0.15;
        pbr.roughness = 0.72;
        box.material = pbr;
        box.meshBlendingTag = PackMeshBlendingTag(2 + i * 2, i as MeshBlendingRadiusClass);
    }

    const sameGroupSphere = MeshBuilder.CreateSphere("same-group-sphere", { diameter: 2.8, segments: 24 }, scene);
    sameGroupSphere.position.set(-0.6, -1.55, -0.1);
    const sameStandard = new StandardMaterial("same-standard", scene);
    sameStandard.diffuseColor = new Color3(0.95, 0.12, 0.65);
    sameStandard.specularColor = new Color3(0.05, 0.05, 0.05);
    sameGroupSphere.material = sameStandard;
    sameGroupSphere.meshBlendingTag = PackMeshBlendingTag(20, MeshBlendingRadiusClass.ExtraLarge);

    const sameGroupBox = MeshBuilder.CreateBox("same-group-box", { size: 2.55 }, scene);
    sameGroupBox.position.set(0.6, -1.55, 0.1);
    sameGroupBox.rotation.z = 0.2;
    const samePbr = new PBRMetallicRoughnessMaterial("same-pbr", scene);
    samePbr.baseColor = new Color3(0.1, 0.9, 0.85);
    samePbr.metallic = 0.05;
    samePbr.roughness = 0.8;
    sameGroupBox.material = samePbr;
    sameGroupBox.meshBlendingTag = PackMeshBlendingTag(20, MeshBlendingRadiusClass.Small);

    const frameGraph = new FrameGraph(scene, true);
    scene.frameGraph = frameGraph;
    const color = frameGraph.textureManager.createRenderTargetTexture("scene310-color", {
        size: { width: 100, height: 100 },
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_HALF_FLOAT],
            formats: [Constants.TEXTUREFORMAT_RGBA],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["scene310-color"],
        },
    });
    const depth = frameGraph.textureManager.createRenderTargetTexture("scene310-depth", {
        size: { width: 100, height: 100 },
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["scene310-depth"],
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
