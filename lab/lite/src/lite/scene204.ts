// Scene 204 — Floating-origin thin instances.
//
// LWR feature coverage: **thin-instance world** under floating origin.
// A single box mesh is placed at world (~5e6, 1, ~5e6) and carries a 5×5
// grid of thin instances whose matrices are LOCAL offsets (small). Both
// Lite and BJS compose `finalWorld = mesh.world * instanceMatrix`, so the
// large world coordinate lives entirely in `mesh.world` — which Lite already
// packs eye-relative under floating origin (the camera offset is subtracted
// in F64 before the F32 store). The GPU therefore multiplies a small
// `mesh.world` by a small local instance matrix: no F32 cancellation, crisp
// instanced geometry at 5e6. No per-instance offset is needed (and would be
// wrong — it would double-subtract). Pairs with lab/lite/src/bjs/scene204.ts.

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
    setThinInstanceColors,
    setThinInstances,
    startEngine,
} from "babylon-lite";

const OFFSET = 5_000_000;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas, { useHighPrecisionMatrix: true, useFloatingOrigin: true });
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.05, b: 0.08, a: 1 };

    const cam = createArcRotateCamera(Math.PI / 4, Math.PI / 3, 22, { x: OFFSET, y: 1, z: OFFSET });
    cam.nearPlane = 0.5;
    cam.farPlane = 500;
    scene.camera = cam;

    const hemi = createHemisphericLight([0, 1, 0], 0.4);
    addToScene(scene, hemi);

    const dir = createDirectionalLight([-0.4, -1, -0.2]);
    dir.diffuse = [1, 1, 1];
    dir.specular = [0.3, 0.3, 0.3];
    addToScene(scene, dir);

    const ground = createGround(engine, { width: 60, height: 60, subdivisions: 1 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.25, 0.25, 0.3];
    ground.material = groundMat;
    ground.position.set(OFFSET, 0, OFFSET);
    addToScene(scene, ground);

    // The feature under test: a thin-instanced box. The mesh NODE sits at the
    // world centre; instance matrices are LOCAL (small) offsets forming a 5×5
    // grid with a height ramp, so the big coordinate stays in mesh.world.
    const box = createBox(engine, 1);
    const boxMat = createStandardMaterial();
    boxMat.diffuseColor = [1, 1, 1];
    boxMat.specularColor = [0.4, 0.4, 0.4];
    box.material = boxMat;
    box.position.set(OFFSET, 1, OFFSET);

    const numPerSide = 5;
    const spacing = 4;
    const instanceCount = numPerSide * numPerSide;
    const matricesData = new Float32Array(16 * instanceCount);
    const colorData = new Float32Array(4 * instanceCount);
    const m = new Float32Array(16);
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;
    let index = 0;
    for (let i = 0; i < numPerSide; i++) {
        for (let j = 0; j < numPerSide; j++) {
            m[12] = (i - 2) * spacing;
            m[13] = ((i + j) % 3) * 0.75;
            m[14] = (j - 2) * spacing;
            matricesData.set(m, index * 16);
            colorData[index * 4 + 0] = 0.3 + (i / (numPerSide - 1)) * 0.6;
            colorData[index * 4 + 1] = 0.4;
            colorData[index * 4 + 2] = 0.3 + (j / (numPerSide - 1)) * 0.6;
            colorData[index * 4 + 3] = 1.0;
            index++;
        }
    }
    setThinInstances(box, matricesData, instanceCount);
    setThinInstanceColors(box, colorData);
    addToScene(scene, box);

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
