import {
    addTask,
    addToScene,
    cloneTransformNode,
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
    MeshBlendQuality,
    MeshBlendingRadiusClass,
    packMeshBlendingTag,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";

function material(color: [number, number, number]) {
    const value = createStandardMaterial();
    value.diffuseColor = [1, 1, 1];
    value.emissiveColor = color;
    value.specularColor = [0, 0, 0];
    value.disableLighting = true;
    return value;
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
    scene.clearColor = { r: 0.02, g: 0.025, b: 0.04, a: 1 };
    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 7, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 60;
    scene.camera = camera;
    addToScene(scene, createHemisphericLight([0.2, 1, -0.25], 1));

    const junctionLeft = createSphere(engine, { diameter: 2.3, segments: 24 });
    junctionLeft.position.set(-0.8, 1.25, 0);
    junctionLeft.material = material([0.95, 0.16, 0.18]);
    junctionLeft.meshBlendingTag = packMeshBlendingTag(1, MeshBlendingRadiusClass.ExtraLarge);
    addToScene(scene, junctionLeft);
    const junctionRight = createSphere(engine, { diameter: 2.3, segments: 24 });
    junctionRight.position.set(0.8, 1.25, 0);
    junctionRight.material = material([0.08, 0.58, 1]);
    junctionRight.meshBlendingTag = packMeshBlendingTag(2, MeshBlendingRadiusClass.ExtraLarge);
    addToScene(scene, junctionRight);
    const junctionCenter = createBox(engine, 1.75);
    junctionCenter.position.set(0, 1.25, -0.35);
    junctionCenter.rotation.z = Math.PI / 4;
    junctionCenter.material = material([0.16, 0.95, 0.32]);
    junctionCenter.meshBlendingTag = packMeshBlendingTag(3, MeshBlendingRadiusClass.Large);
    addToScene(scene, junctionCenter);

    const fallbackHost = createBox(engine, 1.75);
    fallbackHost.position.set(-4.25, -1.45, 0.2);
    fallbackHost.material = material([0.16, 0.55, 0.95]);
    fallbackHost.meshBlendingTag = packMeshBlendingTag(4, MeshBlendingRadiusClass.ExtraLarge);
    addToScene(scene, fallbackHost);
    const tinyTarget = createSphere(engine, { diameter: 0.48, segments: 16 });
    tinyTarget.position.set(-3.55, -1.45, -0.55);
    tinyTarget.material = material([1, 0.55, 0.06]);
    tinyTarget.meshBlendingTag = packMeshBlendingTag(5, MeshBlendingRadiusClass.Small);
    addToScene(scene, tinyTarget);

    const continuationHost = createSphere(engine, { diameter: 1.9, segments: 24 });
    continuationHost.position.set(-0.9, -1.55, 0.2);
    continuationHost.material = material([0.8, 0.16, 0.86]);
    continuationHost.meshBlendingTag = packMeshBlendingTag(6, MeshBlendingRadiusClass.Large);
    addToScene(scene, continuationHost);
    const continuationSliver = createBox(engine, 1);
    continuationSliver.scaling.set(0.16, 1.15, 0.35);
    continuationSliver.position.set(-0.05, -1.55, -0.5);
    continuationSliver.rotation.z = 0.35;
    continuationSliver.material = material([0.95, 0.9, 0.12]);
    continuationSliver.meshBlendingTag = packMeshBlendingTag(7, MeshBlendingRadiusClass.Medium);
    addToScene(scene, continuationSliver);

    const source = createSphere(engine, { diameter: 0.9, segments: 18 });
    source.position.set(2.1, -1.55, -0.35);
    source.material = material([0.1, 0.9, 0.82]);
    source.meshBlendingTag = packMeshBlendingTag(10, MeshBlendingRadiusClass.Large);
    addToScene(scene, source);
    const clone = cloneTransformNode(source) as Mesh;
    clone.position.set(3.75, -1.55, -0.35);
    clone.meshBlendingTag = source.meshBlendingTag;
    addToScene(scene, clone);
    for (const x of [2.45, 4.1]) {
        const contact = createBox(engine, 1);
        contact.position.set(x, -1.55, 0.05);
        contact.material = material([0.95, 0.34, 0.08]);
        contact.meshBlendingTag = packMeshBlendingTag(11, MeshBlendingRadiusClass.Medium);
        addToScene(scene, contact);
    }

    const sceneColor = createRenderTarget({ lbl: "scene314-color", format: "rgba16float", samples: 1, size: engine });
    const geometry = createGeometryRendererTask(
        {
            name: "scene314-geometry",
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
            name: "scene314-mesh-blend",
            sourceTexture: geometry.outputTexture!,
            meshBlendTagTexture: geometry.geometryMeshBlendTagTexture!,
            depthTexture: geometry.geometryViewDepthTexture!,
            targetTexture: engine.scRT,
            camera,
            quality: MeshBlendQuality.Cinematic,
            radiusClasses: [
                { worldRadius: 0.12, minimumProjectedRadius: 2 },
                { worldRadius: 0.2, minimumProjectedRadius: 3 },
                { worldRadius: 0.32, minimumProjectedRadius: 4 },
                { worldRadius: 0.48, minimumProjectedRadius: 6 },
            ],
            slopeFactor: 1.25,
        },
        engine,
        scene
    );
    addTask(scene, geometry);
    addTask(scene, blend);

    await registerScene(scene);
    blend.updateUniforms();
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
