import {
    addBillboardSpriteIndex,
    addToScene,
    addAxisLockedBillboardSystem,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    createAxisLockedBillboardSystem,
    loadSpriteAtlas,
    registerScene,
    startEngine,
} from "babylon-lite";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

const CAMERA_ALPHA = -Math.PI / 4;
const CAMERA_BETA = 1.15;

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.14, g: 0.16, b: 0.2, a: 1 };

    scene.camera = createArcRotateCamera(CAMERA_ALPHA, CAMERA_BETA, 10, { x: 0, y: 1, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 100;

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.85));

    const box1 = createBox(engine, 1.2);
    box1.position.set(-2.5, 0.6, 0);
    const mat1 = createStandardMaterial();
    mat1.diffuseColor = [0.4, 0.5, 0.7];
    box1.material = mat1;
    addToScene(scene, box1);

    const box2 = createBox(engine, 1.2);
    box2.position.set(2.5, 0.6, 0);
    const mat2 = createStandardMaterial();
    mat2.diffuseColor = [0.7, 0.5, 0.4];
    box2.material = mat2;
    addToScene(scene, box2);

    const box3 = createBox(engine, 0.8);
    box3.position.set(0, 0.4, 2.8);
    const mat3 = createStandardMaterial();
    mat3.diffuseColor = [0.5, 0.7, 0.5];
    box3.material = mat3;
    addToScene(scene, box3);

    const atlas = await loadSpriteAtlas(engine, getSpriteAtlasDataUrl(), {
        gridSize: [SPRITE_ATLAS_INFO.cellWidthPx, SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "linear",
    });
    const billboards = createAxisLockedBillboardSystem(atlas, [0.35, 1, 0.2], { capacity: 6 });

    addBillboardSpriteIndex(billboards, {
        position: [-2.5, 2.2, 0],
        sizeWorld: [1.4, 0.9],
        frame: 5,
        color: [1, 1, 1, 0.92],
    });
    addBillboardSpriteIndex(billboards, {
        position: [2.5, 2.2, 0],
        sizeWorld: [1.3, 0.85],
        frame: 11,
        color: [1, 1, 1, 0.88],
        flipX: true,
    });
    addBillboardSpriteIndex(billboards, {
        position: [0, 1.8, 2.8],
        sizeWorld: [1.1, 0.75],
        frame: 17,
        color: [1, 1, 1, 0.85],
    });
    addBillboardSpriteIndex(billboards, {
        position: [-1.2, 3, -1.5],
        sizeWorld: [1.5, 1],
        frame: 23,
        color: [1, 1, 1, 0.9],
    });
    addAxisLockedBillboardSystem(scene, billboards);

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
