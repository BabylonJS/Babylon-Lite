// Scene 35 — Sprites Anchored Animated + Cutout (Family 2).
//
// Two anchored layers in a 3D scene with a static camera:
//   1. Alpha-blend layer: 3 sprites running a 4-frame `spin` clip at 8 fps.
//      The clip is frozen at `?seekTime=` so the golden is deterministic.
//      One sprite has rotation = π/4 to exercise the rotation path.
//   2. Cutout layer: 2 sprites with `alphaCutoff = 0.5`, depthWrite-on by
//      default, placed in front of geometry so the depth-write contract is
//      visible (cutout silhouettes punch sharp holes vs. blended sprites).
//
// Picking smoke-test: pick at the projected center of one visible and one
// non-pickable sprite; results land on `canvas.dataset.pickResults`.

import {
    addAnchoredSpriteIndex,
    addToScene,
    createAnchoredSpriteLayer,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGround,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    getViewProjectionMatrix,
    loadSpriteAtlas,
    onBeforeRender,
    pickAnchoredSprite,
    playAnchoredSpriteClipIndex,
    startEngine,
    stopAnchoredSpriteClipIndex,
} from "babylon-lite";
import { CUTOUT_ATLAS_INFO, getCutoutAtlasDataUrl } from "../_shared/sprite-cutout-atlas";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const seekParam = new URLSearchParams(location.search).get("seekTime");
    // Default seekTime lands the spin clip on a non-trivial frame.
    const seekTime = seekParam !== null ? parseFloat(seekParam) : 0.5;

    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.03, g: 0.04, b: 0.06, a: 1 };
    scene.fixedDeltaMs = 16.667;

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.4, 7, { x: 0, y: 0.4, z: 0 });
    scene.camera.fov = Math.PI / 4;
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 50;

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.95));

    // Ground + 2 boxes.
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.3, 0.32, 0.38];
    const ground = createGround(engine, { width: 8, height: 8 });
    ground.material = groundMat;
    addToScene(scene, ground);

    const boxMatA = createStandardMaterial();
    boxMatA.diffuseColor = [0.85, 0.3, 0.25];
    const boxA = createBox(engine, 0.7);
    boxA.material = boxMatA;
    boxA.position.x = -1.4;
    boxA.position.y = 0.35;
    addToScene(scene, boxA);

    const boxMatB = createStandardMaterial();
    boxMatB.diffuseColor = [0.25, 0.55, 0.85];
    const boxB = createBox(engine, 0.7);
    boxB.material = boxMatB;
    boxB.position.x = 1.4;
    boxB.position.y = 0.35;
    boxB.position.z = -0.4;
    addToScene(scene, boxB);

    const atlas = await loadSpriteAtlas(engine, getCutoutAtlasDataUrl(), {
        cellWidthPx: CUTOUT_ATLAS_INFO.cellWidthPx,
        cellHeightPx: CUTOUT_ATLAS_INFO.cellHeightPx,
        columns: CUTOUT_ATLAS_INFO.columns,
        rows: CUTOUT_ATLAS_INFO.rows,
        sampling: "linear",
        clips: [CUTOUT_ATLAS_INFO.spinClip],
    });

    // Layer A — alpha blend, animated.
    const alphaLayer = createAnchoredSpriteLayer(atlas, { capacity: 8, blendMode: "alpha", order: 1 });
    const alphaSprites: number[] = [];
    alphaSprites.push(addAnchoredSpriteIndex(alphaLayer, { position: [-1.4, 1.0, 0], sizePx: [80, 80] }));
    alphaSprites.push(addAnchoredSpriteIndex(alphaLayer, { position: [1.4, 1.0, -0.4], sizePx: [80, 80] }));
    // Rotated sprite at center to exercise the pivot-aware rotation path.
    alphaSprites.push(addAnchoredSpriteIndex(alphaLayer, { position: [0, 1.4, 0], sizePx: [80, 80], rotation: Math.PI / 4 }));
    for (const i of alphaSprites) {
        playAnchoredSpriteClipIndex(alphaLayer, i, "spin", true);
    }
    // Phase the third sprite differently so the golden shows two frames.
    const lastClip = alphaLayer._clips.get(alphaSprites[2]!)!;
    lastClip.elapsedMs = 1000 / CUTOUT_ATLAS_INFO.spinClip.fps; // +1 frame phase
    addToScene(scene, alphaLayer);

    // Layer B — cutout, depth-write on (default).
    // These sprites sit in front of the boxes and punch sharp holes.
    const cutoutLayer = createAnchoredSpriteLayer(atlas, { capacity: 4, blendMode: "cutout", alphaCutoff: 0.5, order: 0 });
    const cutoutPickable = addAnchoredSpriteIndex(cutoutLayer, { position: [-0.6, 0.5, -1.2], sizePx: [120, 120], frame: 0 });
    const cutoutNotPickable = addAnchoredSpriteIndex(cutoutLayer, { position: [0.6, 0.5, -1.2], sizePx: [120, 120], frame: 2, pickable: false });
    addToScene(scene, cutoutLayer);

    // Animation freeze for deterministic capture.
    let elapsedFrames = 0;
    const targetFrames = Math.round(seekTime * 60);
    onBeforeRender(scene, () => {
        elapsedFrames++;
        if (elapsedFrames === targetFrames + 1) {
            for (const i of alphaSprites) {
                stopAnchoredSpriteClipIndex(alphaLayer, i);
            }
            canvas.dataset.animationFrozen = "true";
        }
    });

    await startEngine(engine, scene);

    // Picking smoke-test on the cutout sprites (one pickable, one not).
    const aspect = canvas.width / canvas.height;
    const vp = getViewProjectionMatrix(scene.camera, aspect) as unknown as Float32Array;
    function projectAnchor(world: [number, number, number]): [number, number] {
        const cx = vp[0]! * world[0] + vp[4]! * world[1] + vp[8]! * world[2] + vp[12]!;
        const cy = vp[1]! * world[0] + vp[5]! * world[1] + vp[9]! * world[2] + vp[13]!;
        const cw = vp[3]! * world[0] + vp[7]! * world[1] + vp[11]! * world[2] + vp[15]!;
        return [((cx / cw) * 0.5 + 0.5) * canvas.width, (1 - ((cy / cw) * 0.5 + 0.5)) * canvas.height];
    }
    const [pxOk, pyOk] = projectAnchor([-0.6, 0.5, -1.2]);
    const [pxNo, pyNo] = projectAnchor([0.6, 0.5, -1.2]);
    canvas.dataset.pickResults = JSON.stringify([
        { label: "pickable-cutout", expectedHit: true, hit: pickAnchoredSprite(scene, pxOk, pyOk) !== null, idx: cutoutPickable },
        { label: "non-pickable-cutout", expectedHit: false, hit: pickAnchoredSprite(scene, pxNo, pyNo) !== null, idx: cutoutNotPickable },
    ]);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
