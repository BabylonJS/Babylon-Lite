// HPM / LWR demo scene shared builder.
//
// Both scene200 (HPM-off, FO-off — the "bad" case) and scene201 (HPM-on,
// FO-on — the "good" case) instantiate this builder with a single flag
// pair. The scene places a 5×5 grid of cubes + a tall orange pillar at
// world (OFFSET, *, OFFSET) with OFFSET = 5e6 — the magnitude that
// matches the BJS reference playground (5U0N0Q#5) and at which F32 ULP
// loss on the `view * world` GPU product becomes obvious to the eye:
// stair-stepped silhouettes, mis-aligned cube faces, and z-fighting.
//
// Side-by-side comparison: open `/scene200.html` and `/scene201.html` in
// two tabs. scene200 shows the F32 artefacts; scene201 renders crisply
// because the LWR M1 substrate (F64 caches + eye-relative upload trick)
// keeps GPU-facing translations small.
//
// The scene is fully deterministic: no animation, no input, single steady
// frame. `canvas.dataset.ready = "true"` is set after the first frame so
// the parity harness can screenshot.

import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createEngine,
    createGround,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    registerScene,
    startEngine,
} from "babylon-lite";

/** World offset where the scene is centred. 5e6 matches the BJS reference
 *  playground (5U0N0Q#5) — the smallest magnitude at which F32 rounding
 *  of the view × world product produces visible artefacts. */
const OFFSET = 5_000_000;

export interface HpmJitterOptions {
    useHighPrecisionMatrix: boolean;
    /** When true, also create the engine with `useFloatingOrigin: true`.
     *  Defaults to false. Scene 201 sets this to true to prove that
     *  HPM-on + floating-origin actually delivers stable rendering at large
     *  world coordinates vs the HPM-off F32 baseline (scene 200). FO is an
     *  engine-wide flag — every scene on the engine participates. */
    useFloatingOrigin?: boolean;
}

export async function runHpmJitterScene(opts: HpmJitterOptions): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas, {
        useHighPrecisionMatrix: opts.useHighPrecisionMatrix,
        useFloatingOrigin: opts.useFloatingOrigin === true,
    });
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.05, b: 0.08, a: 1 };

    // ArcRotate camera ~25m back from the grid centre. Eye position is
    // (OFFSET + ~25*cos, ..., OFFSET + ~25*sin) — order 5e6 in magnitude.
    const cam = createArcRotateCamera(Math.PI / 4, Math.PI / 3, 25, { x: OFFSET, y: 1, z: OFFSET });
    cam.nearPlane = 0.5;
    cam.farPlane = 500;
    scene.camera = cam;

    const hemi = createHemisphericLight([0, 1, 0], 0.4);
    addToScene(scene, hemi);

    const dir = createDirectionalLight([-0.4, -1, -0.2]);
    dir.diffuse = [1, 1, 1];
    dir.specular = [0.3, 0.3, 0.3];
    addToScene(scene, dir);

    const ground = createGround(engine, { width: 40, height: 40, subdivisions: 1 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.25, 0.25, 0.3];
    ground.material = groundMat;
    ground.position.set(OFFSET, 0, OFFSET);
    addToScene(scene, ground);

    // 5×5 grid of unit boxes, spacing 4m, centred on (OFFSET, 1, OFFSET).
    // Each cube has a slightly different colour so the eye can spot
    // per-cube edge shifts between the FO-off and FO-on variants.
    for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
            const box = createBox(engine, 1);
            const boxMat = createStandardMaterial();
            const r = 0.3 + (i / 4) * 0.6;
            const g = 0.4;
            const b = 0.3 + (j / 4) * 0.6;
            boxMat.diffuseColor = [r, g, b];
            boxMat.specularColor = [0.4, 0.4, 0.4];
            box.material = boxMat;
            box.position.set(OFFSET + (i - 2) * 4, 1, OFFSET + (j - 2) * 4);
            addToScene(scene, box);
        }
    }

    // Central pillar — taller and brighter so the eye-anchor for jitter is
    // unambiguous. F32 rounding shifts the rasterised silhouette by a full
    // pixel or more at OFFSET=5e6.
    const pillar = createBox(engine, 1);
    const pillarMat = createStandardMaterial();
    pillarMat.diffuseColor = [0.9, 0.5, 0.2];
    pillarMat.emissiveColor = [0.1, 0.05, 0.02];
    pillarMat.specularColor = [0.6, 0.6, 0.6];
    pillar.material = pillarMat;
    pillar.position.set(OFFSET, 2, OFFSET);
    pillar.scaling.set(0.8, 4, 0.8);
    addToScene(scene, pillar);

    await registerScene(engine, scene);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.useHighPrecisionMatrix = String(engine.useHighPrecisionMatrix);
    canvas.dataset.useFloatingOrigin = String(opts.useFloatingOrigin === true);
    canvas.dataset.offset = String(OFFSET);
    canvas.dataset.ready = "true";
}
