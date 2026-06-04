// Scene 203 — Floating-origin spot light.
//
// LWR feature coverage: **spot-light position** under floating origin.
// A spot light hangs ~12 m above the geometry, aimed straight down, casting
// a circular pool of light on the ground. The whole scene sits at world
// (~5e6, *, ~5e6). The spot's world position is order 5e6, so the
// position-dependent diffuse/specular term would jitter under F32 without
// floating origin. With `useFloatingOrigin: true` the lights UBO bakes the
// active camera position into the spot position (its DIRECTION, a rotation
// column, is left untouched) so the GPU shades eye-relative — a crisp,
// stable light cone. Pairs with lab/lite/src/bjs/scene203.ts.

import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGround,
    createHemisphericLight,
    createSceneContext,
    createSphere,
    createSpotLight,
    createStandardMaterial,
    registerScene,
    startEngine,
} from "babylon-lite";

const OFFSET = 5_000_000;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas, { useHighPrecisionMatrix: true, useFloatingOrigin: true });
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.05, b: 0.08, a: 1 };

    const cam = createArcRotateCamera(Math.PI / 4, Math.PI / 3.2, 18, { x: OFFSET, y: 1, z: OFFSET });
    cam.nearPlane = 0.5;
    cam.farPlane = 500;
    scene.camera = cam;

    const hemi = createHemisphericLight([0, 1, 0], 0.1);
    addToScene(scene, hemi);

    // The feature under test: a spot light at large world coords aimed down.
    const spot = createSpotLight([OFFSET, 12, OFFSET], [0, -1, 0], Math.PI / 4, 2, 1.5);
    spot.diffuse = [1, 0.95, 0.85];
    spot.specular = [1, 1, 1];
    spot.range = 100;
    addToScene(scene, spot);

    const ground = createGround(engine, { width: 40, height: 40, subdivisions: 1 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.32, 0.32, 0.36];
    groundMat.specularColor = [0.2, 0.2, 0.2];
    ground.material = groundMat;
    ground.position.set(OFFSET, 0, OFFSET);
    addToScene(scene, ground);

    // Ring of boxes inside the cone so the edge of the lit pool is visible.
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const box = createBox(engine, 1);
        const boxMat = createStandardMaterial();
        boxMat.diffuseColor = [0.6, 0.45, 0.4];
        boxMat.specularColor = [0.5, 0.5, 0.5];
        box.material = boxMat;
        box.position.set(OFFSET + Math.cos(a) * 5, 0.5, OFFSET + Math.sin(a) * 5);
        addToScene(scene, box);
    }

    const sphere = createSphere(engine, { diameter: 3, segments: 32 });
    const sphereMat = createStandardMaterial();
    sphereMat.diffuseColor = [0.8, 0.8, 0.85];
    sphereMat.specularColor = [0.9, 0.9, 0.9];
    sphere.material = sphereMat;
    sphere.position.set(OFFSET, 1.5, OFFSET);
    addToScene(scene, sphere);

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
