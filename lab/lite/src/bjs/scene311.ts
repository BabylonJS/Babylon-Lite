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
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { MeshBlendingRadiusClass, PackMeshBlendingTag } from "@babylonjs/core/Meshes/meshBlendingTag";
import { MeshBlendDebugMode, MeshBlendDepthType, MeshBlendQuality } from "@babylonjs/core/PostProcesses/thinMeshBlendingPostProcess";
import { Scene } from "@babylonjs/core/scene";

type Color = readonly [number, number, number];

function createSolidTexture(scene: Scene, color: Color): RawTexture {
    return RawTexture.CreateRGBATexture(
        new Uint8Array([Math.round(color[0] * 255), Math.round(color[1] * 255), Math.round(color[2] * 255), 255]),
        1,
        1,
        scene,
        false,
        false,
        Texture.NEAREST_SAMPLINGMODE
    );
}

function createTaggedPlane(scene: Scene, width: number, x: number, renderedColor: Color, baseColor: Color, groupId: number) {
    const plane = MeshBuilder.CreatePlane(`plane-${groupId}-${x}`, { width, height: 4.5 }, scene);
    plane.position.set(x, 0, 0);
    const material = new StandardMaterial(`material-${groupId}-${x}`, scene);
    material.diffuseTexture = createSolidTexture(scene, baseColor);
    material.diffuseColor = Color3.White();
    material.emissiveColor = new Color3(
        renderedColor[0] / Math.max(baseColor[0], 1 / 255),
        renderedColor[1] / Math.max(baseColor[1], 1 / 255),
        renderedColor[2] / Math.max(baseColor[2], 1 / 255)
    );
    material.specularColor = Color3.Black();
    material.disableLighting = true;
    material.backFaceCulling = false;
    plane.material = material;
    plane.meshBlendingTag = PackMeshBlendingTag(groupId, MeshBlendingRadiusClass.ExtraLarge);
    return plane;
}

(async function () {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: false });
    await engine.initAsync();
    engine.useReverseDepthBuffer = true;
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.015, 0.015, 0.02, 1);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2, 10, Vector3.Zero(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 40;
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    const updateOrtho = () => {
        const halfHeight = 3;
        const halfWidth = halfHeight * (engine.getRenderWidth() / engine.getRenderHeight());
        camera.orthoLeft = -halfWidth;
        camera.orthoRight = halfWidth;
        camera.orthoTop = halfHeight;
        camera.orthoBottom = -halfHeight;
    };
    updateOrtho();
    scene.activeCamera = camera;

    const cellWidth = 10 / 3;
    for (let index = 0; index < 3; index++) {
        const cellStart = -5 + index * cellWidth;
        const currentGroup = 1 + index * 2;
        const targetGroup = currentGroup + 1;
        createTaggedPlane(scene, 1.55, cellStart + 0.775, [0.32, 0.35, 0.4], [0.32, 0.35, 0.4], currentGroup);
        createTaggedPlane(scene, 0.24, cellStart + 1.67, [0.015, 0.004, 0.001], [1, 0.48, 0.04], targetGroup);
        createTaggedPlane(scene, cellWidth - 1.79, cellStart + (cellWidth + 1.79) * 0.5, [1, 0.48, 0.04], [1, 0.48, 0.04], targetGroup);
    }

    const frameGraph = new FrameGraph(scene, true);
    scene.frameGraph = frameGraph;
    const color = frameGraph.textureManager.createRenderTargetTexture("scene311-color", {
        size: { width: 100, height: 100 },
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_HALF_FLOAT],
            formats: [Constants.TEXTUREFORMAT_RGBA],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["scene311-color"],
        },
    });
    const depth = frameGraph.textureManager.createRenderTargetTexture("scene311-depth", {
        size: { width: 100, height: 100 },
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["scene311-depth"],
        },
    });
    const outputTexture = frameGraph.textureManager.createRenderTargetTexture("scene311-output", {
        size: { width: 100, height: 100 },
        sizeIsPercentage: true,
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_HALF_FLOAT],
            formats: [Constants.TEXTUREFORMAT_RGBA],
            samples: 1,
            useSRGBBuffers: [false],
            labels: ["scene311-output"],
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
        { type: Constants.PREPASS_ALBEDO_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA },
    ];
    frameGraph.addTask(geometry);
    const render = new FrameGraphObjectRendererTask("render", frameGraph, scene);
    render.targetTexture = clear.outputTexture;
    render.depthTexture = geometry.outputDepthTexture;
    render.camera = camera;
    render.objectList = { meshes: scene.meshes, particleSystems: [] };
    frameGraph.addTask(render);
    const clearOutput = new FrameGraphClearTextureTask("clear-output", frameGraph);
    clearOutput.color = scene.clearColor;
    clearOutput.targetTexture = outputTexture;
    clearOutput.clearDepth = false;
    frameGraph.addTask(clearOutput);
    const radiusClasses = [
        { worldRadius: 0.06, minimumProjectedRadius: 1.5 },
        { worldRadius: 0.1, minimumProjectedRadius: 3 },
        { worldRadius: 0.2, minimumProjectedRadius: 3 },
        { worldRadius: 0, minimumProjectedRadius: 320 },
    ] as const;
    const withoutAlbedo = new FrameGraphMeshBlendingTask("without-albedo", frameGraph);
    withoutAlbedo.sourceTexture = render.outputTexture;
    withoutAlbedo.meshBlendTagTexture = geometry.geometryMeshBlendTagTexture;
    withoutAlbedo.depthTexture = geometry.geometryScreenDepthTexture;
    withoutAlbedo.targetTexture = clearOutput.outputTexture;
    withoutAlbedo.camera = camera;
    withoutAlbedo.configure({
        quality: MeshBlendQuality.High,
        depthType: MeshBlendDepthType.Screen,
        debugMode: MeshBlendDebugMode.ShadowAttenuation,
        radiusClasses,
        slopeFactor: 1,
    });
    withoutAlbedo.viewport = { x: 0, y: 0, width: 0.5, height: 1 };
    frameGraph.addTask(withoutAlbedo);
    const withAlbedo = new FrameGraphMeshBlendingTask("with-albedo", frameGraph);
    withAlbedo.sourceTexture = render.outputTexture;
    withAlbedo.meshBlendTagTexture = geometry.geometryMeshBlendTagTexture;
    withAlbedo.depthTexture = geometry.geometryScreenDepthTexture;
    withAlbedo.baseColorTexture = geometry.geometryAlbedoTexture;
    withAlbedo.targetTexture = withoutAlbedo.outputTexture;
    withAlbedo.camera = camera;
    withAlbedo.configure({
        quality: MeshBlendQuality.High,
        depthType: MeshBlendDepthType.Screen,
        debugMode: MeshBlendDebugMode.ShadowAttenuation,
        radiusClasses,
        slopeFactor: 1,
    });
    withAlbedo.viewport = { x: 0.5, y: 0, width: 0.5, height: 1 };
    frameGraph.addTask(withAlbedo);
    const output = new FrameGraphCopyToBackbufferColorTask("output", frameGraph);
    output.sourceTexture = withAlbedo.outputTexture;
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
