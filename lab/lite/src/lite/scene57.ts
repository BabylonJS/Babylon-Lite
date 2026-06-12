import {
    addBillboardSpriteIndex,
    addFacingBillboardSystem,
    addToScene,
    billboardBlendCutout,
    createBox,
    createEngine,
    createFacingBillboardSystem,
    createFreeCamera,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    loadSpriteAtlas,
    registerScene,
    startEngine,
} from "babylon-lite";
import { CUTOUT_SPRITE_ATLAS_INFO, getCutoutSpriteAtlasDataUrl } from "../_shared/sprite-atlas-cutout";

const CAMERA_POSITION = { x: 0, y: 1.05, z: -6 };
const CAMERA_TARGET = { x: 0, y: 0.75, z: 1.0 };

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.09, g: 0.11, b: 0.14, a: 1 };

    scene.camera = createFreeCamera(CAMERA_POSITION, CAMERA_TARGET);
    scene.camera.fov = 0.72;
    scene.camera.nearPlane = 0.5;
    scene.camera.farPlane = 80;

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.9));

    const addBoxAt = (position: [number, number, number], scale: [number, number, number], color: [number, number, number]): void => {
        const box = createBox(engine, 1);
        box.position.set(position[0], position[1], position[2]);
        box.scaling.set(scale[0], scale[1], scale[2]);
        const material = createStandardMaterial();
        material.diffuseColor = color;
        box.material = material;
        addToScene(scene, box);
    };

    addBoxAt([0, 0.65, 2.45], [5.2, 2.45, 0.12], [0.18, 0.24, 0.32]);
    addBoxAt([-1.45, 0.7, 2.25], [0.42, 2.15, 0.18], [0.85, 0.22, 0.18]);
    addBoxAt([0, 0.7, 2.18], [0.42, 2.15, 0.18], [0.22, 0.68, 0.34]);
    addBoxAt([1.45, 0.7, 2.25], [0.42, 2.15, 0.18], [0.28, 0.45, 0.92]);
    addBoxAt([0, -0.75, 0.95], [4.8, 0.16, 3.4], [0.38, 0.34, 0.27]);
    addBoxAt([1.3, 0.05, -0.05], [0.95, 0.95, 0.95], [0.63, 0.55, 0.42]);

    const atlas = await loadSpriteAtlas(engine, getCutoutSpriteAtlasDataUrl(), {
        gridSize: [CUTOUT_SPRITE_ATLAS_INFO.cellWidthPx, CUTOUT_SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "nearest",
    });
    const billboards = createFacingBillboardSystem(atlas, { capacity: 5, blendMode: billboardBlendCutout, alphaCutoff: 0.5 });

    addBillboardSpriteIndex(billboards, {
        position: [0, 0.75, 0.15],
        sizeWorld: [2.35, 2.35],
        frame: 3,
    });
    addBillboardSpriteIndex(billboards, {
        position: [-0.8, 0.65, 1.15],
        sizeWorld: [1.75, 2.1],
        frame: 0,
    });
    addBillboardSpriteIndex(billboards, {
        position: [0.95, 0.45, 0.95],
        sizeWorld: [1.45, 1.55],
        frame: 1,
        rotation: 0.1,
    });
    addBillboardSpriteIndex(billboards, {
        position: [-1.45, -0.15, -0.35],
        sizeWorld: [1.25, 1.55],
        frame: 2,
        rotation: -0.12,
    });
    addFacingBillboardSystem(scene, billboards);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});