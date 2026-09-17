import {
    addTask,
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGeometryRendererTask,
    createHemisphericLight,
    createMeshBlendingPostProcessTask,
    createRenderTarget,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    GeometryTextureType,
    MeshBlendingRadiusClass,
    packMeshBlendingTag,
    registerScene,
    startEngine,
} from "babylon-lite";

const COLORS: [number, number, number][] = [
    [1.15, 0.18, 0.08],
    [0.08, 0.55, 1.1],
    [0.18, 1.0, 0.28],
    [1.1, 0.55, 0.05],
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
    scene.clearColor = { r: 0.025, g: 0.035, b: 0.055, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 9.5, { x: 0, y: -0.1, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    addToScene(scene, createHemisphericLight([0.2, 1, -0.3], 1.1));

    const xs = [-3.9, -1.3, 1.3, 3.9];
    for (let i = 0; i < xs.length; i++) {
        const sphere = createSphere(engine, { diameter: 2.6, segments: 24 });
        sphere.position.set(xs[i]! - 0.48, 1.05, -0.1);
        const standard = createStandardMaterial();
        standard.diffuseColor = COLORS[i]!;
        standard.emissiveColor = COLORS[i]!.map((value) => value * 0.08) as [number, number, number];
        standard.specularColor = [0.08, 0.08, 0.08];
        sphere.material = standard;
        sphere.meshBlendingTag = packMeshBlendingTag(1 + i * 2, i as MeshBlendingRadiusClass);
        addToScene(scene, sphere);

        const box = createBox(engine, 2.35);
        box.position.set(xs[i]! + 0.48, 1.05, 0.1);
        box.rotation.y = 0.25;
        const boxMaterial = createStandardMaterial();
        boxMaterial.diffuseColor = COLORS[(i + 1) % COLORS.length]!;
        boxMaterial.specularColor = [0.08, 0.08, 0.08];
        box.material = boxMaterial;
        box.meshBlendingTag = packMeshBlendingTag(2 + i * 2, i as MeshBlendingRadiusClass);
        addToScene(scene, box);
    }

    const sameGroupSphere = createSphere(engine, { diameter: 2.8, segments: 24 });
    sameGroupSphere.position.set(-0.6, -1.55, -0.1);
    sameGroupSphere.material = Object.assign(createStandardMaterial(), {
        diffuseColor: [0.95, 0.12, 0.65] as [number, number, number],
        specularColor: [0.05, 0.05, 0.05] as [number, number, number],
    });
    sameGroupSphere.meshBlendingTag = packMeshBlendingTag(20, MeshBlendingRadiusClass.ExtraLarge);
    addToScene(scene, sameGroupSphere);

    const sameGroupBox = createBox(engine, 2.55);
    sameGroupBox.position.set(0.6, -1.55, 0.1);
    sameGroupBox.rotation.z = 0.2;
    const sameBoxMaterial = createStandardMaterial();
    sameBoxMaterial.diffuseColor = [0.1, 0.9, 0.85];
    sameBoxMaterial.specularColor = [0.05, 0.05, 0.05];
    sameGroupBox.material = sameBoxMaterial;
    sameGroupBox.meshBlendingTag = packMeshBlendingTag(20, MeshBlendingRadiusClass.Small);
    addToScene(scene, sameGroupBox);

    const sceneColor = createRenderTarget({ lbl: "scene310-color", format: "rgba16float", samples: 1, size: engine });
    const geometry = createGeometryRendererTask(
        {
            name: "scene310-geometry",
            samples: 1,
            textureDescriptions: [{ type: GeometryTextureType.MESH_BLEND_TAG }, { type: GeometryTextureType.VIEW_DEPTH, format: "r16float" }],
            targetTexture: sceneColor,
            targetTextureClearColor: scene.clearColor,
        },
        engine,
        scene
    );
    const blend = createMeshBlendingPostProcessTask(
        {
            name: "scene310-mesh-blend",
            sourceTexture: geometry.outputTexture!,
            meshBlendTagTexture: geometry.geometryMeshBlendTagTexture!,
            depthTexture: geometry.geometryViewDepthTexture!,
            targetTexture: engine.scRT,
            camera,
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
