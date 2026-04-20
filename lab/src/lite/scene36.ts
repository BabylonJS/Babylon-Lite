// Scene 36 — Billboard Facing (Family 3, spherical billboard).
//
// Five sprites at varying world Y rendered through `createFacingBillboardSystem`.
// Quad basis comes from the camera's right + up vectors (extracted on the CPU
// each frame), so sprites face the camera fully — top edges tilt toward the
// camera as it tilts down.
//
// Reference path: Babylon.js `SpriteManager` (see `bjs/scene36.ts`). BJS
// SpriteManager uses the same spherical-billboard math, so the parity diff is
// driven only by float rounding in the shaders + texture sampling — which is
// expected to land well under MAD 0.01.

import {
    addBillboardSpriteIndex,
    addToScene,
    createArcRotateCamera,
    createFacingBillboardSystem,
    createGround,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    createEngine,
    loadSpriteAtlas,
    onBeforeRender,
    startEngine,
} from "babylon-lite";
import { BILLBOARD_ATLAS_INFO, BILLBOARD_ATLAS_URL } from "../_shared/sprite-billboard-atlas";
import { BILLBOARD_SCENE_LAYOUT } from "../_shared/billboard-scene-layout";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const seekParam = new URLSearchParams(location.search).get("seekTime");
    const seekTime = seekParam !== null ? parseFloat(seekParam) : 1.0;

    const scene = createSceneContext(engine);
    scene.clearColor = BILLBOARD_SCENE_LAYOUT.clearColor;
    scene.fixedDeltaMs = 16.667;

    const cam = BILLBOARD_SCENE_LAYOUT.camera;
    scene.camera = createArcRotateCamera(cam.alpha, cam.beta, cam.radius, cam.target);
    scene.camera.fov = cam.fov;
    scene.camera.nearPlane = cam.near;
    scene.camera.farPlane = cam.far;

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.95));

    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = BILLBOARD_SCENE_LAYOUT.groundColor;
    const ground = createGround(engine, { width: 12, height: 12 });
    ground.material = groundMat;
    addToScene(scene, ground);

    const atlas = await loadSpriteAtlas(engine, BILLBOARD_ATLAS_URL, {
        cellWidthPx: BILLBOARD_ATLAS_INFO.cellWidthPx,
        cellHeightPx: BILLBOARD_ATLAS_INFO.cellHeightPx,
        columns: BILLBOARD_ATLAS_INFO.columns,
        rows: BILLBOARD_ATLAS_INFO.rows,
        sampling: "linear",
    });

    const layer = createFacingBillboardSystem(atlas, { capacity: 8, blendMode: "alpha" });
    for (const s of BILLBOARD_SCENE_LAYOUT.sprites) {
        addBillboardSpriteIndex(layer, {
            position: s.position,
            sizeWorld: s.sizeWorld,
            frame: BILLBOARD_ATLAS_INFO.frames.glow,
        });
    }
    addToScene(scene, layer);

    let frames = 0;
    const target = Math.round(seekTime * 60);
    onBeforeRender(scene, () => {
        frames++;
        if (frames === target + 1) {
            canvas.dataset.animationFrozen = "true";
        }
    });

    await startEngine(engine, scene);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
