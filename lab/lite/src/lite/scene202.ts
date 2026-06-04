// Scene 202 — Floating-origin point light.
//
// LWR feature coverage: **point-light position** under floating origin.
// The whole scene sits at world (~5e6, *, ~5e6). A single point light is
// placed a few metres above the geometry; its world position is order 5e6,
// so the diffuse/specular term `lightPos - worldPos` would suffer F32
// catastrophic cancellation if the position were uploaded raw. With
// `useFloatingOrigin: true` the lights UBO bakes the active camera's world
// position into every point/spot light position, so the GPU sees an
// eye-relative (small-magnitude) light position that matches the
// eye-relative mesh world positions — crisp, jitter-free shading.
//
// Paired BJS reference: lab/lite/src/bjs/scene202.ts (useLargeWorldRendering).
// Geometry, materials, camera and lighting MUST stay in sync between the two.

import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGround,
    createHemisphericLight,
    createPointLight,
    createSceneContext,
    createSphere,
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

    const cam = createArcRotateCamera(Math.PI / 4, Math.PI / 3, 14, { x: OFFSET, y: 1, z: OFFSET });
    cam.nearPlane = 0.5;
    cam.farPlane = 500;
    scene.camera = cam;

    // Low hemispheric fill so unlit faces aren't fully black (direction-based,
    // no floating-origin participation — matches the BJS HemisphericLight).
    const hemi = createHemisphericLight([0, 1, 0], 0.15);
    addToScene(scene, hemi);

    // The feature under test: a point light at large world coords. Its position
    // is offset by the camera world position in the lights UBO when FO is on.
    const point = createPointLight([OFFSET + 4, 6, OFFSET - 2], 1.0);
    point.diffuse = [1, 0.95, 0.8];
    point.specular = [1, 1, 1];
    point.range = 100;
    addToScene(scene, point);

    const ground = createGround(engine, { width: 40, height: 40, subdivisions: 1 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.3, 0.3, 0.34];
    groundMat.specularColor = [0.2, 0.2, 0.2];
    ground.material = groundMat;
    ground.position.set(OFFSET, 0, OFFSET);
    addToScene(scene, ground);

    // 3×3 grid of unit boxes around the centre.
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            const box = createBox(engine, 1);
            const boxMat = createStandardMaterial();
            boxMat.diffuseColor = [0.35 + (i / 2) * 0.5, 0.4, 0.35 + (j / 2) * 0.5];
            boxMat.specularColor = [0.5, 0.5, 0.5];
            box.material = boxMat;
            box.position.set(OFFSET + (i - 1) * 5, 1, OFFSET + (j - 1) * 5);
            addToScene(scene, box);
        }
    }

    // Central sphere — its smooth specular highlight is the most sensitive
    // probe of point-light position precision.
    const sphere = createSphere(engine, { diameter: 3, segments: 32 });
    const sphereMat = createStandardMaterial();
    sphereMat.diffuseColor = [0.8, 0.8, 0.85];
    sphereMat.specularColor = [0.9, 0.9, 0.9];
    sphere.material = sphereMat;
    sphere.position.set(OFFSET, 2.5, OFFSET);
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
