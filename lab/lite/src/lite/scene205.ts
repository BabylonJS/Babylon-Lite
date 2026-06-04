// Scene 205 — Floating-origin facing billboard sprites (transparent).
//
// LWR feature coverage: **world-space billboard sprite anchors** under floating
// origin, exercising the *sorted/transparent* upload path
// (`uploadSortedBillboardInstances`). The whole scene sits at world
// (~5e6, *, ~5e6). Each billboard's anchor position is order 5e6, so the
// vertex shader's `scene.viewProjection * worldPos` would suffer F32
// catastrophic cancellation if the anchor were uploaded raw (the FO
// view-projection is eye-relative). With `useFloatingOrigin: true` the
// billboard upload bakes the active camera's world position into every
// anchor, so the GPU sees eye-relative anchors that match the eye-relative
// view-projection — crisp, jitter-free camera-facing cards.
//
// Paired BJS reference: lab/lite/src/bjs/scene205.ts (useLargeWorldRendering,
// SpriteManager). Geometry, materials, camera, atlas, sprite positions/sizes/
// colors/flips MUST stay in sync between the two.

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

const OFFSET = 5_000_000;
const CAMERA_ALPHA = -Math.PI / 3;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { useHighPrecisionMatrix: true, useFloatingOrigin: true });
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.16, g: 0.18, b: 0.22, a: 1 };

    const cam = createArcRotateCamera(CAMERA_ALPHA, 1.35, 8, { x: OFFSET + 0.2, y: 0.05, z: OFFSET });
    cam.nearPlane = 1;
    cam.farPlane = 100;
    scene.camera = cam;

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.9));

    const centerBox = createBox(engine, 1.65);
    centerBox.position.set(OFFSET, -0.05, OFFSET - 1.05);
    const centerMaterial = createStandardMaterial();
    centerMaterial.diffuseColor = [0.5, 0.55, 0.62];
    centerBox.material = centerMaterial;
    addToScene(scene, centerBox);

    const sideBox = createBox(engine, 0.85);
    sideBox.position.set(OFFSET + 1.65, -0.65, OFFSET + 0.55);
    const sideMaterial = createStandardMaterial();
    sideMaterial.diffuseColor = [0.26, 0.42, 0.72];
    sideBox.material = sideMaterial;
    addToScene(scene, sideBox);

    const atlas = await loadSpriteAtlas(engine, getSpriteAtlasDataUrl(), {
        gridSize: [SPRITE_ATLAS_INFO.cellWidthPx, SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "linear",
    });
    const billboards = createFacingBillboardSystem(atlas, { capacity: 6 });

    // Billboard anchors are stored in an F32 instance buffer, so at world scale
    // (~5e6) the per-anchor x/z must be exactly F32-representable to avoid
    // quantization (the F32 ULP near 5e6 is 0.5). Every anchor below offsets the
    // OFFSET (itself a multiple of 0.5) by a multiple of 0.5, so the stored value
    // is lossless and the eye-relative result matches BJS (which keeps sprite
    // positions in F64). Mesh world matrices keep full F64 precision separately.
    addBillboardSpriteIndex(billboards, {
        position: [OFFSET - 1.5, 0.7, OFFSET - 2.0],
        sizeWorld: [1.25, 0.8],
        frame: 8,
        color: [1, 1, 1, 0.95],
    });
    addBillboardSpriteIndex(billboards, {
        position: [OFFSET, 0.05, OFFSET],
        sizeWorld: [1.65, 1.05],
        frame: 13,
        color: [1, 1, 1, 0.9],
    });
    addBillboardSpriteIndex(billboards, {
        position: [OFFSET + 1.5, -0.25, OFFSET + 1.5],
        sizeWorld: [1.35, 0.95],
        frame: 18,
        color: [1, 1, 1, 0.88],
        flipX: true,
    });
    addBillboardSpriteIndex(billboards, {
        position: [OFFSET - 0.5, -0.95, OFFSET + 1.0],
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
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.useHighPrecisionMatrix = String(engine.useHighPrecisionMatrix);
    canvas.dataset.useFloatingOrigin = "true";
    canvas.dataset.offset = String(OFFSET);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
