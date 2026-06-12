import {
    addBillboardSprite,
    addFacingBillboardSystem,
    addToScene,
    attachSpriteAnimationsToScene,
    createBox,
    createEngine,
    createFacingBillboardSystem,
    createFreeCamera,
    createHemisphericLight,
    createSceneContext,
    createSpriteAnimationManager,
    createStandardMaterial,
    loadSpriteAtlas,
    playBillboardSpriteAnimation,
    registerScene,
    startEngine,
} from "babylon-lite";
import { seekSpriteAnimationManager } from "../_shared/player-lite-sprite";
import { PLAYER_SPRITE_INFO, PLAYER_SPRITE_URL } from "../_shared/player-sprite";

const CAMERA_POSITION = { x: 0, y: 1.05, z: -5.6 };
const CAMERA_TARGET = { x: 0, y: 0.25, z: 0.75 };

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.07, g: 0.09, b: 0.12, a: 1 };

    scene.camera = createFreeCamera(CAMERA_POSITION, CAMERA_TARGET);
    scene.camera.fov = 0.68;
    scene.camera.nearPlane = 0.5;
    scene.camera.farPlane = 80;

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.92));
    addBoxAt(scene, engine, [0, -0.86, 1.2], [4.8, 0.16, 3.2], [0.32, 0.29, 0.25]);
    addBoxAt(scene, engine, [0, 0.58, 2.55], [4.8, 1.8, 0.12], [0.15, 0.22, 0.3]);
    addBoxAt(scene, engine, [-1.65, -0.05, 1.45], [0.28, 1.55, 0.2], [0.8, 0.24, 0.2]);
    addBoxAt(scene, engine, [1.65, -0.05, 1.45], [0.28, 1.55, 0.2], [0.25, 0.48, 0.95]);

    const atlas = await loadSpriteAtlas(engine, PLAYER_SPRITE_URL, {
        gridSize: [PLAYER_SPRITE_INFO.frameWidthPx, PLAYER_SPRITE_INFO.frameHeightPx],
        sampling: "linear",
    });
    const billboards = createFacingBillboardSystem(atlas, { capacity: 4 });
    const manager = createSpriteAnimationManager();

    const mainRunner = addBillboardSprite(billboards, {
        position: [0, -0.155, 0.15],
        sizeWorld: [1.25, 1.25],
        frame: 0,
        color: [1, 1, 1, 1],
    });
    const reverseRunner = addBillboardSprite(billboards, {
        position: [-1.28, -0.205, 0.95],
        sizeWorld: [0.95, 0.95],
        frame: 10,
        flipX: true,
        color: [0.65, 0.85, 1, 0.82],
    });
    const finishRunner = addBillboardSprite(billboards, {
        position: [1.28, -0.22, 0.82],
        sizeWorld: [0.8, 0.8],
        frame: 0,
        color: [1, 0.85, 0.7, 0.78],
    });

    playBillboardSpriteAnimation(manager, mainRunner, PLAYER_SPRITE_INFO.runStartFrame, PLAYER_SPRITE_INFO.runEndFrame, true, PLAYER_SPRITE_INFO.delayMs);
    playBillboardSpriteAnimation(manager, reverseRunner, PLAYER_SPRITE_INFO.runEndFrame, PLAYER_SPRITE_INFO.runStartFrame, true, PLAYER_SPRITE_INFO.delayMs);
    playBillboardSpriteAnimation(manager, finishRunner, 0, 6, false, PLAYER_SPRITE_INFO.delayMs, { removeWhenFinished: true });
    addFacingBillboardSystem(scene, billboards);

    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "");
    if (Number.isFinite(seekTime)) {
        seekSpriteAnimationManager(manager, seekTime);
        canvas.dataset.animationFrozen = "true";
    } else {
        attachSpriteAnimationsToScene(scene, manager);
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

function addBoxAt(
    scene: ReturnType<typeof createSceneContext>,
    engine: Awaited<ReturnType<typeof createEngine>>,
    position: [number, number, number],
    scale: [number, number, number],
    color: [number, number, number]
): void {
    const box = createBox(engine, 1);
    box.position.set(position[0], position[1], position[2]);
    box.scaling.set(scale[0], scale[1], scale[2]);
    const material = createStandardMaterial();
    material.diffuseColor = color;
    box.material = material;
    addToScene(scene, box);
}

main().catch((error) => {
    console.error(error);
});
