import {
    addBillboardSpriteIndex,
    addFacingBillboardSystem,
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createFacingBillboardSystem,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    loadSpriteAtlas,
    registerScene,
    startEngine,
} from "babylon-lite";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

const CAMERA_ALPHA = -Math.PI / 3;

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.16, g: 0.18, b: 0.22, a: 1 };

    scene.camera = createArcRotateCamera(CAMERA_ALPHA, 1.35, 8, { x: 0.2, y: 0.05, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 100;

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.9));

    const centerBox = createBox(engine, 1.65);
    centerBox.position.set(0, -0.05, -1.05);
    const centerMaterial = createStandardMaterial();
    centerMaterial.diffuseColor = [0.5, 0.55, 0.62];
    centerBox.material = centerMaterial;
    addToScene(scene, centerBox);

    const sideBox = createBox(engine, 0.85);
    sideBox.position.set(1.65, -0.65, 0.55);
    const sideMaterial = createStandardMaterial();
    sideMaterial.diffuseColor = [0.26, 0.42, 0.72];
    sideBox.material = sideMaterial;
    addToScene(scene, sideBox);

    const atlas = await loadSpriteAtlas(engine, getSpriteAtlasDataUrl(), {
        gridSize: [SPRITE_ATLAS_INFO.cellWidthPx, SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "linear",
    });
    const billboards = createFacingBillboardSystem(atlas, { capacity: 6, blendMode: "alpha" });

    addBillboardSpriteIndex(billboards, {
        position: [-1.6, 0.7, -2.15],
        sizeWorld: [1.25, 0.8],
        frame: 8,
        color: [1, 1, 1, 0.95],
    });
    addBillboardSpriteIndex(billboards, {
        position: [0, 0.05, 0.15],
        sizeWorld: [1.65, 1.05],
        frame: 13,
        color: [1, 1, 1, 0.9],
    });
    addBillboardSpriteIndex(billboards, {
        position: [1.65, -0.25, 1.45],
        sizeWorld: [1.35, 0.95],
        frame: 18,
        color: [1, 1, 1, 0.88],
        flipX: true,
    });
    addBillboardSpriteIndex(billboards, {
        position: [-0.55, -0.95, 1.05],
        sizeWorld: [0.95, 1.25],
        frame: 26,
        pivot: [0.5, 0.62],
        color: [1, 1, 1, 0.82],
        flipY: true,
    });
    addFacingBillboardSystem(scene, billboards);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});