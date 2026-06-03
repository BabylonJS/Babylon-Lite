import {
    addBillboardSpriteIndex,
    addFacingBillboardSystem,
    createEngine,
    createFacingBillboardSystem,
    createFreeCamera,
    createSceneContext,
    loadSpriteAtlas,
    registerScene,
    startEngine,
} from "babylon-lite";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "../_shared/sprite-atlas-image";

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.1, g: 0.12, b: 0.16, a: 1 };

    scene.camera = createFreeCamera({ x: 0, y: 0, z: -6 }, { x: 0, y: 0, z: 1.2 });
    scene.camera.fov = 0.8;
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 100;

    const atlas = await loadSpriteAtlas(engine, getSpriteAtlasDataUrl(), {
        gridSize: [SPRITE_ATLAS_INFO.cellWidthPx, SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "linear",
    });
    const billboards = createFacingBillboardSystem(atlas, { capacity: 3 });

    addBillboardSpriteIndex(billboards, {
        position: [-0.35, -0.2, 0],
        sizeWorld: [2.7, 2.7],
        frame: 18,
        color: [1, 1, 1, 0.58],
    });
    addBillboardSpriteIndex(billboards, {
        position: [0, 0, 1.2],
        sizeWorld: [2.7, 2.7],
        frame: 13,
        color: [1, 1, 1, 0.58],
    });
    addBillboardSpriteIndex(billboards, {
        position: [0.35, 0.2, 2.4],
        sizeWorld: [2.7, 2.7],
        frame: 8,
        color: [1, 1, 1, 0.58],
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
