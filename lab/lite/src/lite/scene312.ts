import {
    addTask,
    addToScene,
    createArcRotateCamera,
    createEngine,
    createGeometryRendererTask,
    createMeshBlendingPostProcessTask,
    createPlane,
    createRenderTarget,
    createSceneContext,
    createStandardMaterial,
    enableOrthographicCamera,
    GeometryTextureType,
    MeshBlendDepthType,
    MeshBlendQuality,
    MeshBlendingRadiusClass,
    packMeshBlendingTag,
    registerScene,
    startEngine,
} from "babylon-lite";

const COLORS: [number, number, number][] = [
    [0.9, 0.18, 0.2],
    [0.15, 0.72, 0.95],
    [0.2, 0.9, 0.4],
    [0.95, 0.62, 0.1],
];

async function waitFrames(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0.03, g: 0.035, b: 0.05, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.2;
    camera.farPlane = 50;
    enableOrthographicCamera(camera, { halfHeight: 3.2 });
    scene.camera = camera;

    for (let index = 0; index < 4; index++) {
        const panel = createPlane(engine, { width: 2.5, height: 5.6 });
        panel.position.set(-3.75 + index * 2.5, 0, 0);
        const material = createStandardMaterial();
        material.diffuseColor = [1, 1, 1];
        material.emissiveColor = COLORS[index]!;
        material.specularColor = [0, 0, 0];
        material.disableLighting = true;
        material.backFaceCulling = false;
        panel.material = material;
        panel.meshBlendingTag = packMeshBlendingTag(index + 1, index as MeshBlendingRadiusClass);
        addToScene(scene, panel);
    }

    const sceneColor = createRenderTarget({ lbl: "scene312-color", format: "rgba16float", samples: 1, size: engine });
    const geometry = createGeometryRendererTask(
        {
            name: "scene312-geometry",
            samples: 1,
            textureDescriptions: [{ type: GeometryTextureType.MESH_BLEND_TAG }, { type: GeometryTextureType.SCREENSPACE_DEPTH }],
            targetTexture: sceneColor,
            targetTextureClearColor: scene.clearColor,
        },
        engine,
        scene
    );
    const blend = createMeshBlendingPostProcessTask(
        {
            name: "scene312-mesh-blend",
            sourceTexture: geometry.outputTexture!,
            meshBlendTagTexture: geometry.geometryMeshBlendTagTexture!,
            depthTexture: geometry.geometryScreenspaceDepthTexture!,
            targetTexture: engine.scRT,
            camera,
            quality: MeshBlendQuality.High,
            depthType: MeshBlendDepthType.Screen,
            radiusClasses: [
                { worldRadius: 0.08, minimumProjectedRadius: 2 },
                { worldRadius: 0.14, minimumProjectedRadius: 3 },
                { worldRadius: 0.22, minimumProjectedRadius: 4 },
                { worldRadius: 0.32, minimumProjectedRadius: 5 },
            ],
            slopeFactor: 1.6,
        },
        engine,
        scene
    );
    addTask(scene, geometry);
    addTask(scene, blend);

    await registerScene(scene);
    blend.updateUniforms();
    await startEngine(engine);
    await waitFrames(8);
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
