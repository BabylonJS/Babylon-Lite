import {
    addTask,
    addToScene,
    createEngine,
    createFreeCamera,
    createGeometryRendererTask,
    createMeshBlendingPostProcessTask,
    createRenderTarget,
    createSceneContext,
    GeometryTextureType,
    getContainerMeshes,
    loadEnvironment,
    loadGltf,
    MeshBlendDepthType,
    MeshBlendQuality,
    MeshBlendingRadiusClass,
    packMeshBlendingTag,
    registerScene,
    startEngine,
} from "babylon-lite";

const ASSET_URL = "https://assets.babylonjs.com/meshes/MeshBlending/coastalCliff.glb";
const ENVIRONMENT_URL = "https://playground.babylonjs.com/textures/country.env";
const MESH_NAMES = [
    "P0006_primitive0",
    "P0060_primitive0",
    "P0061_primitive0",
    "P0071_primitive0",
    "P0072_primitive0",
    "P0073_primitive0",
    "P0076_primitive0",
    "P0077_primitive0",
    "P0078_primitive0",
    "P0079_primitive0",
    "P0080_primitive0",
    "P0081_primitive0",
    "P0082_primitive0",
    "P0083_primitive0",
    "P0084_primitive0",
    "GPU_1_1",
    "GPU_2_2",
] as const;

async function waitFrames(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0.025, g: 0.035, b: 0.045, a: 1 };

    const [container] = await Promise.all([
        loadGltf(engine, ASSET_URL),
        loadEnvironment(scene, ENVIRONMENT_URL, {
            brdfUrl: "/brdf-lut.png",
            skipGround: true,
            skipSkybox: true,
        }),
    ]);
    addToScene(scene, container);
    scene.imageProcessing.toneMappingEnabled = false;
    scene.imageProcessing.exposure = 1;
    scene.imageProcessing.contrast = 1;

    const renderMeshes = getContainerMeshes(container);
    if (renderMeshes.length !== MESH_NAMES.length) {
        throw new Error(`Expected ${MESH_NAMES.length} coastal-cliff primitive meshes, found ${renderMeshes.length}.`);
    }
    for (let index = 0; index < renderMeshes.length; index++) {
        const mesh = renderMeshes[index]!;
        mesh.name = MESH_NAMES[index]!;
        mesh.meshBlendingTag = mesh.name === "P0078_primitive0" || mesh.name === "P0079_primitive0" ? 0 : packMeshBlendingTag((index % 63) + 1, MeshBlendingRadiusClass.Small);
    }

    const camera = createFreeCamera(
        { x: 19.196982408059775, y: 6.201319223798063, z: -18.734448534771463 },
        { x: 23.34427328356007, y: -11.02970061387117, z: 58.197432388998195 }
    );
    camera.nearPlane = 0.01;
    camera.farPlane = 2000;
    scene.camera = camera;

    const sceneColor = createRenderTarget({ lbl: "scene315-color", format: engine.format, samples: 1, size: engine });
    const geometry = createGeometryRendererTask(
        {
            name: "scene315-geometry",
            samples: 1,
            textureDescriptions: [{ type: GeometryTextureType.MESH_BLEND_TAG }, { type: GeometryTextureType.SCREENSPACE_DEPTH }, { type: GeometryTextureType.ALBEDO }],
            targetTexture: sceneColor,
            targetTextureClearColor: scene.clearColor,
            meshes: renderMeshes,
        },
        engine,
        scene
    );
    const blend = createMeshBlendingPostProcessTask(
        {
            name: "scene315-mesh-blend",
            sourceTexture: geometry.outputTexture!,
            meshBlendTagTexture: geometry.geometryMeshBlendTagTexture!,
            depthTexture: geometry.geometryScreenspaceDepthTexture!,
            baseColorTexture: geometry.geometryAlbedoTexture!,
            targetTexture: engine.scRT,
            camera,
            quality: MeshBlendQuality.Medium,
            depthType: MeshBlendDepthType.Screen,
            radiusClasses: [
                { worldRadius: 0.2759, minimumProjectedRadius: 1.5 },
                { worldRadius: 0.5518, minimumProjectedRadius: 3 },
                { worldRadius: 1.1035, minimumProjectedRadius: 3 },
                { worldRadius: 2.2071, minimumProjectedRadius: 5 },
            ],
            slopeFactor: 2,
        },
        engine,
        scene
    );
    addTask(scene, geometry);
    addTask(scene, blend);

    await registerScene(scene);
    blend.updateUniforms();
    await startEngine(engine);
    await waitFrames(15);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
});
