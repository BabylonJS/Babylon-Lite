// Scene 206 — Floating-origin cutout billboard sprites (alpha-tested).
//
// LWR feature coverage: **world-space billboard sprite anchors** under floating
// origin, exercising the *opaque/cutout* upload path (`uploadBillboardInstances`,
// the non-sorted branch used by depth-writing alpha-tested billboards). The
// whole scene sits at world (~5e6, *, ~5e6). Each billboard anchor is order 5e6,
// so the vertex shader's `scene.viewProjection * worldPos` would suffer F32
// catastrophic cancellation if the anchor were uploaded raw. With
// `useFloatingOrigin: true` the billboard upload bakes the active camera world
// position into every anchor (re-uploading whenever the camera moves), so the
// GPU sees eye-relative anchors matching the eye-relative view-projection.
//
// Billboard anchors live in an F32 instance buffer, so at world scale the
// per-anchor x/z must be exactly F32-representable (multiples of 0.5 near 5e6)
// to avoid quantization that BJS — which keeps sprite positions in F64 — does
// not incur. Every anchor below offsets OFFSET by a multiple of 0.5.
//
// Paired BJS reference: lab/lite/src/bjs/scene206.ts (useLargeWorldRendering +
// alpha-test facing planes). Geometry, materials, camera, atlas, and sprite
// positions/sizes/frames MUST stay in sync between the two.

import {
    addBillboardSpriteIndex,
    addFacingBillboardSystem,
    addToScene,
    billboardBlendCutout,
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
import { CUTOUT_SPRITE_ATLAS_INFO, getCutoutSpriteAtlasDataUrl } from "../_shared/sprite-atlas-cutout";

const OFFSET = 5_000_000;
// ArcRotate parameters reproducing a camera at (OFFSET, 1.05, OFFSET - 6) looking
// at (OFFSET, 0.75, OFFSET + 1) — a near-straight-on, slightly elevated view of
// the cutout cards, matching the LWR foundation scenes' ArcRotate camera style.
const CAMERA_ALPHA = -Math.PI / 2;
const CAMERA_BETA = 1.52797;
const CAMERA_RADIUS = 7.00643;
const CAMERA_TARGET = { x: OFFSET, y: 0.75, z: OFFSET + 1.0 };

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { useHighPrecisionMatrix: true, useFloatingOrigin: true });
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.09, g: 0.11, b: 0.14, a: 1 };

    const cam = createArcRotateCamera(CAMERA_ALPHA, CAMERA_BETA, CAMERA_RADIUS, CAMERA_TARGET);
    cam.fov = 0.72;
    cam.nearPlane = 0.5;
    cam.farPlane = 80;
    scene.camera = cam;

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

    addBoxAt([OFFSET, 0.65, OFFSET + 2.45], [5.2, 2.45, 0.12], [0.18, 0.24, 0.32]);
    addBoxAt([OFFSET - 1.45, 0.7, OFFSET + 2.25], [0.42, 2.15, 0.18], [0.85, 0.22, 0.18]);
    addBoxAt([OFFSET, 0.7, OFFSET + 2.18], [0.42, 2.15, 0.18], [0.22, 0.68, 0.34]);
    addBoxAt([OFFSET + 1.45, 0.7, OFFSET + 2.25], [0.42, 2.15, 0.18], [0.28, 0.45, 0.92]);
    addBoxAt([OFFSET, -0.75, OFFSET + 0.95], [4.8, 0.16, 3.4], [0.38, 0.34, 0.27]);
    addBoxAt([OFFSET + 1.3, 0.05, OFFSET - 0.05], [0.95, 0.95, 0.95], [0.63, 0.55, 0.42]);

    const atlas = await loadSpriteAtlas(engine, getCutoutSpriteAtlasDataUrl(), {
        gridSize: [CUTOUT_SPRITE_ATLAS_INFO.cellWidthPx, CUTOUT_SPRITE_ATLAS_INFO.cellHeightPx],
        sampling: "nearest",
    });
    const billboards = createFacingBillboardSystem(atlas, { capacity: 5, blendMode: billboardBlendCutout, alphaCutoff: 0.5 });

    addBillboardSpriteIndex(billboards, {
        position: [OFFSET, 0.75, OFFSET],
        sizeWorld: [2.35, 2.35],
        frame: 3,
    });
    addBillboardSpriteIndex(billboards, {
        position: [OFFSET - 1.0, 0.65, OFFSET + 1.0],
        sizeWorld: [1.75, 2.1],
        frame: 0,
    });
    addBillboardSpriteIndex(billboards, {
        position: [OFFSET + 1.0, 0.45, OFFSET + 1.0],
        sizeWorld: [1.45, 1.55],
        frame: 1,
        rotation: 0.1,
    });
    addBillboardSpriteIndex(billboards, {
        position: [OFFSET - 1.5, -0.15, OFFSET - 0.5],
        sizeWorld: [1.25, 1.55],
        frame: 2,
        rotation: -0.12,
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
