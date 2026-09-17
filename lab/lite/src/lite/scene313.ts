import {
    addTask,
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGeometryRendererTask,
    createHemisphericLight,
    createMeshBlendingPostProcessTask,
    createPbrMaterial,
    createPlane,
    createRenderTarget,
    createSceneContext,
    createStandardMaterial,
    createTexture2DFromPixels,
    GeometryTextureType,
    MeshBlendDebugMode,
    MeshBlendingRadiusClass,
    packMeshBlendingTag,
    registerScene,
    setPbrAlphaCutoff,
    startEngine,
} from "babylon-lite";

const TEXTURE_SIZE = 64;

function createCutoutPixels(): Uint8Array {
    const pixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
    for (let y = 0; y < TEXTURE_SIZE; y++) {
        for (let x = 0; x < TEXTURE_SIZE; x++) {
            const offset = (y * TEXTURE_SIZE + x) * 4;
            const cellX = (x % 16) - 7.5;
            const cellY = (y % 16) - 7.5;
            const opaque = cellX * cellX + cellY * cellY < 34 || ((x >> 3) + (y >> 3)) % 4 === 0;
            pixels[offset] = 245;
            pixels[offset + 1] = 205 - ((x >> 3) % 2) * 85;
            pixels[offset + 2] = 55 + ((y >> 3) % 2) * 150;
            pixels[offset + 3] = opaque ? 255 : 0;
        }
    }
    return pixels;
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
    scene.clearColor = { r: 0.025, g: 0.03, b: 0.045, a: 1 };
    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 7, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 40;
    scene.camera = camera;
    addToScene(scene, createHemisphericLight([0.15, 1, -0.2], 1));

    const texture = createTexture2DFromPixels(engine, createCutoutPixels(), TEXTURE_SIZE, TEXTURE_SIZE, {
        minFilter: "nearest",
        magFilter: "nearest",
        addressModeU: "repeat",
        addressModeV: "repeat",
    });

    const standardBack = createBox(engine, 3.25);
    standardBack.scaling.set(1, 1, 0.22);
    standardBack.position.set(-2.2, 0, 0.55);
    const standardBackMaterial = createStandardMaterial();
    standardBackMaterial.diffuseColor = [0.1, 0.55, 0.95];
    standardBackMaterial.specularColor = [0, 0, 0];
    standardBack.material = standardBackMaterial;
    standardBack.meshBlendingTag = packMeshBlendingTag(1, MeshBlendingRadiusClass.Medium);
    addToScene(scene, standardBack);

    const standardCutout = createPlane(engine, { width: 3.25, height: 3.25 });
    standardCutout.position.set(-2.2, 0, -0.35);
    const standardCutoutMaterial = createStandardMaterial();
    standardCutoutMaterial.diffuseTexture = texture;
    standardCutoutMaterial.diffuseColor = [1, 1, 1];
    standardCutoutMaterial.emissiveColor = [0.08, 0.08, 0.08];
    standardCutoutMaterial.alphaCutOff = 0.5;
    standardCutoutMaterial.backFaceCulling = false;
    standardCutout.material = standardCutoutMaterial;
    standardCutout.meshBlendingTag = packMeshBlendingTag(2, MeshBlendingRadiusClass.Large);
    addToScene(scene, standardCutout);

    const pbrBack = createBox(engine, 3.25);
    pbrBack.scaling.set(1, 1, 0.22);
    pbrBack.position.set(2.2, 0, 0.55);
    const pbrBackMaterial = createStandardMaterial();
    pbrBackMaterial.diffuseColor = [0.15, 0.9, 0.35];
    pbrBackMaterial.specularColor = [0, 0, 0];
    pbrBack.material = pbrBackMaterial;
    pbrBack.meshBlendingTag = packMeshBlendingTag(3, MeshBlendingRadiusClass.Medium);
    addToScene(scene, pbrBack);

    const pbrCutout = createPlane(engine, { width: 3.25, height: 3.25 });
    pbrCutout.position.set(2.2, 0, -0.35);
    const pbrCutoutMaterial = createPbrMaterial({
        baseColorTexture: texture,
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 0,
        roughnessFactor: 0.82,
        doubleSided: true,
    });
    setPbrAlphaCutoff(pbrCutoutMaterial, 0.5);
    pbrCutout.material = pbrCutoutMaterial;
    pbrCutout.meshBlendingTag = packMeshBlendingTag(4, MeshBlendingRadiusClass.ExtraLarge);
    addToScene(scene, pbrCutout);

    const sceneColor = createRenderTarget({ lbl: "scene313-color", format: "rgba16float", samples: 1, size: engine });
    const geometry = createGeometryRendererTask(
        {
            name: "scene313-geometry",
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
            name: "scene313-mesh-blend",
            sourceTexture: geometry.outputTexture!,
            meshBlendTagTexture: geometry.geometryMeshBlendTagTexture!,
            depthTexture: geometry.geometryViewDepthTexture!,
            targetTexture: engine.scRT,
            camera,
            debugMode: MeshBlendDebugMode.PackedTag,
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
