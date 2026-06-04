// Scene 98 — Billboard Additive Blend
//
// The facing-billboard scene from scene 54/94, but the system is drawn with the
// opt-in `billboardBlendAdditive` blend mode (src-alpha, one). Several large
// overlapping billboards are placed in front of two boxes so the additive
// brightening where the billboards overlap is obvious. Fully-opaque icon frames
// (8..23) are used, and the layout is static / deterministic — no time term.
//
// Parity oracle: BJS SpriteManager renders the same billboards with the
// ALPHA_ONEONE blend mode and each sprite's RGB pre-multiplied by its own alpha,
// so `one * (rgb*a)` matches Lite's `src-alpha * rgb` for the opaque cells.

import {
    addBillboardSpriteIndex,
    addFacingBillboardSystem,
    addToScene,
    billboardBlendAdditive,
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

export interface Scene98Billboard {
    position: [number, number, number];
    sizeWorld: [number, number];
    frame: number;
    color: [number, number, number, number];
}

export const SCENE98_BILLBOARDS: Scene98Billboard[] = [
    { position: [-0.6, 0.2, 2.2], sizeWorld: [2.2, 2.2], frame: 9, color: [1.0, 0.5, 0.4, 0.8] },
    { position: [0.4, 0.0, 2.0], sizeWorld: [2.2, 2.2], frame: 14, color: [0.4, 0.8, 1.0, 0.8] },
    { position: [-0.1, -0.4, 1.8], sizeWorld: [2.0, 2.0], frame: 18, color: [0.6, 1.0, 0.5, 0.7] },
    { position: [0.9, 0.5, 2.4], sizeWorld: [1.8, 1.8], frame: 11, color: [1.0, 0.9, 0.3, 0.7] },
    { position: [-0.9, -0.2, 2.6], sizeWorld: [1.6, 1.6], frame: 21, color: [0.8, 0.4, 1.0, 0.7] },
];

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1 };

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

    const billboards = createFacingBillboardSystem(atlas, { capacity: SCENE98_BILLBOARDS.length, blendMode: billboardBlendAdditive });
    for (const bb of SCENE98_BILLBOARDS) {
        addBillboardSpriteIndex(billboards, { position: bb.position, sizeWorld: bb.sizeWorld, frame: bb.frame, color: bb.color });
    }
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
