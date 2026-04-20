// Scene 34 — Sprites Anchored Labels (Family 2: AnchoredSpriteLayer).
//
// 4 procedural boxes at varying camera distances; one anchored label per
// box. Labels stay the same pixel size regardless of distance — the
// headline contract of Family 2. One sprite is `pickable: false` to verify
// picking honors the flag.

import {
    addAnchoredSpriteIndex,
    addToScene,
    createAnchoredSpriteLayer,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    getViewProjectionMatrix,
    loadSpriteAtlas,
    pickAnchoredSprite,
    startEngine,
} from "babylon-lite";
import { getLabelAtlasDataUrl, LABEL_ATLAS_INFO } from "../_shared/sprite-label-atlas";

async function bootScene34(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.04, g: 0.06, b: 0.1, a: 1 };

    scene.camera = createArcRotateCamera(-Math.PI / 2.2, Math.PI / 2.6, 14, { x: 0, y: 0.5, z: 3.5 });
    scene.camera.fov = Math.PI / 4;
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 100;

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.95));

    const colors: [number, number, number][] = [
        [0.9, 0.25, 0.25],
        [0.25, 0.75, 0.35],
        [0.3, 0.5, 0.95],
        [0.95, 0.78, 0.2],
    ];
    const sizes = [1.0, 1.4, 0.8, 1.6];
    const zs = [0, 2.5, 5, 7.5];
    const boxAnchors: [number, number, number][] = [];
    for (let i = 0; i < 4; i++) {
        const s = sizes[i]!;
        const mat = createStandardMaterial();
        mat.diffuseColor = colors[i]!;
        const box = createBox(engine, s);
        box.material = mat;
        box.position.x = -3 + i * 2;
        box.position.y = s / 2;
        box.position.z = zs[i]!;
        addToScene(scene, box);
        boxAnchors.push([box.position.x, box.position.y + s / 2 + 0.1, box.position.z]);
    }

    const atlas = await loadSpriteAtlas(engine, getLabelAtlasDataUrl(), {
        cellWidthPx: LABEL_ATLAS_INFO.cellWidthPx,
        cellHeightPx: LABEL_ATLAS_INFO.cellHeightPx,
        columns: LABEL_ATLAS_INFO.columns,
        rows: LABEL_ATLAS_INFO.rows,
        sampling: "linear",
    });

    const layer = createAnchoredSpriteLayer(atlas, { capacity: 8, blendMode: "alpha" });
    for (let i = 0; i < boxAnchors.length; i++) {
        addAnchoredSpriteIndex(layer, {
            position: boxAnchors[i]!,
            sizePx: [56, 56],
            offsetPx: [0, -32],
            frame: i,
            pickable: i !== 2,
        });
    }
    addToScene(scene, layer);

    await startEngine(engine, scene);

    const aspect = canvas.width / canvas.height;
    const vp = getViewProjectionMatrix(scene.camera, aspect) as unknown as Float32Array;
    const results: { i: number; pickable: boolean; hit: boolean }[] = [];
    for (let i = 0; i < boxAnchors.length; i++) {
        const [wx, wy, wz] = boxAnchors[i]!;
        const cx = vp[0]! * wx + vp[4]! * wy + vp[8]! * wz + vp[12]!;
        const cy = vp[1]! * wx + vp[5]! * wy + vp[9]! * wz + vp[13]!;
        const cw = vp[3]! * wx + vp[7]! * wy + vp[11]! * wz + vp[15]!;
        const px = ((cx / cw) * 0.5 + 0.5) * canvas.width;
        const py = (1 - ((cy / cw) * 0.5 + 0.5)) * canvas.height;
        const hit = pickAnchoredSprite(scene, px, py - 32);
        results.push({ i, pickable: i !== 2, hit: hit !== null });
    }
    canvas.dataset.pickResults = JSON.stringify(results);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

bootScene34().catch(console.error);
