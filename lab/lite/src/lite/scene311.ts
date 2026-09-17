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
    createTexture2DFromPixels,
    enableOrthographicCamera,
    GeometryTextureType,
    MeshBlendDebugMode,
    MeshBlendDepthType,
    MeshBlendQuality,
    MeshBlendingRadiusClass,
    packMeshBlendingTag,
    registerScene,
    startEngine,
} from "babylon-lite";

type Color = readonly [number, number, number];

function createSolidTexture(engine: Parameters<typeof createTexture2DFromPixels>[0], color: Color) {
    return createTexture2DFromPixels(engine, new Uint8Array([Math.round(color[0] * 255), Math.round(color[1] * 255), Math.round(color[2] * 255), 255]), 1, 1);
}

function createTaggedPlane(engine: Parameters<typeof createPlane>[0], width: number, x: number, renderedColor: Color, baseColor: Color, groupId: number) {
    const plane = createPlane(engine, { width, height: 7.2 });
    plane.position.set(x, 0, 0);
    const material = createStandardMaterial();
    material.diffuseTexture = createSolidTexture(engine, baseColor);
    material.diffuseColor = [1, 1, 1];
    material.emissiveColor = [
        renderedColor[0] / Math.max(baseColor[0], 1 / 255),
        renderedColor[1] / Math.max(baseColor[1], 1 / 255),
        renderedColor[2] / Math.max(baseColor[2], 1 / 255),
    ];
    material.specularColor = [0, 0, 0];
    material.disableLighting = true;
    material.backFaceCulling = false;
    plane.material = material;
    plane.meshBlendingTag = packMeshBlendingTag(groupId, MeshBlendingRadiusClass.ExtraLarge);
    return plane;
}

async function waitFrames(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0.015, g: 0.015, b: 0.02, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 40;
    enableOrthographicCamera(camera, { halfHeight: 3 });
    scene.camera = camera;

    const cellWidth = 10 / 3;
    for (let index = 0; index < 3; index++) {
        const cellStart = -5 + index * cellWidth;
        const currentGroup = 1 + index * 2;
        const targetGroup = currentGroup + 1;
        addToScene(scene, createTaggedPlane(engine, 1.55, cellStart + 0.775, [0.32, 0.35, 0.4], [0.32, 0.35, 0.4], currentGroup));
        addToScene(scene, createTaggedPlane(engine, 0.24, cellStart + 1.67, [0.015, 0.004, 0.001], [1, 0.48, 0.04], targetGroup));
        addToScene(scene, createTaggedPlane(engine, cellWidth - 1.79, cellStart + (cellWidth + 1.79) * 0.5, [1, 0.48, 0.04], [1, 0.48, 0.04], targetGroup));
    }

    const sceneColor = createRenderTarget({ lbl: "scene311-color", format: "rgba16float", samples: 1, size: engine });
    const geometry = createGeometryRendererTask(
        {
            name: "scene311-geometry",
            samples: 1,
            textureDescriptions: [{ type: GeometryTextureType.MESH_BLEND_TAG }, { type: GeometryTextureType.SCREENSPACE_DEPTH }, { type: GeometryTextureType.ALBEDO }],
            targetTexture: sceneColor,
            targetTextureClearColor: scene.clearColor,
        },
        engine,
        scene
    );
    const radiusClasses = [
        { worldRadius: 0.06, minimumProjectedRadius: 1.5 },
        { worldRadius: 0.1, minimumProjectedRadius: 3 },
        { worldRadius: 0.2, minimumProjectedRadius: 3 },
        { worldRadius: 0, minimumProjectedRadius: 320 },
    ] as const;
    const withoutAlbedo = createMeshBlendingPostProcessTask(
        {
            name: "scene311-no-albedo",
            sourceTexture: geometry.outputTexture!,
            meshBlendTagTexture: geometry.geometryMeshBlendTagTexture!,
            depthTexture: geometry.geometryScreenspaceDepthTexture!,
            targetTexture: engine.scRT,
            camera,
            quality: MeshBlendQuality.High,
            depthType: MeshBlendDepthType.Screen,
            debugMode: MeshBlendDebugMode.ShadowAttenuation,
            radiusClasses,
            slopeFactor: 1,
            viewport: { x: 0, y: 0, width: 0.5, height: 1 },
        },
        engine,
        scene
    );
    const withAlbedo = createMeshBlendingPostProcessTask(
        {
            name: "scene311-with-albedo",
            sourceTexture: geometry.outputTexture!,
            meshBlendTagTexture: geometry.geometryMeshBlendTagTexture!,
            depthTexture: geometry.geometryScreenspaceDepthTexture!,
            baseColorTexture: geometry.geometryAlbedoTexture!,
            targetTexture: engine.scRT,
            camera,
            quality: MeshBlendQuality.High,
            depthType: MeshBlendDepthType.Screen,
            debugMode: MeshBlendDebugMode.ShadowAttenuation,
            radiusClasses,
            slopeFactor: 1,
            viewport: { x: 0.5, y: 0, width: 0.5, height: 1 },
            clear: false,
        },
        engine,
        scene
    );
    addTask(scene, geometry);
    addTask(scene, withoutAlbedo);
    addTask(scene, withAlbedo);

    await registerScene(scene);
    withoutAlbedo.updateUniforms();
    withAlbedo.updateUniforms();
    await startEngine(engine);
    await waitFrames(10);
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
