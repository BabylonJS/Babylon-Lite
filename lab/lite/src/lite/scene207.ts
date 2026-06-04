// Scene 207 — Floating-origin directional shadows (PCF).
//
// LWR feature coverage: **shadow light-space matrix** under floating origin.
// The whole scene sits at world (~5e6, *, ~5e6). A directional light casts
// PCF shadows from a sphere + boxes onto a ground receiver. The shadow
// generator's light view/projection ("lightMatrix") would be built from the
// raw world-space light position (order 5e6) and multiplied against the
// eye-relative mesh world matrices used by the caster pass and the receiver
// shader — a coordinate-space mismatch that destroys the shadow at large
// coordinates. With `useFloatingOrigin: true` the light view is built
// eye-relative (the active camera's world position is subtracted from the
// light position and the caster AABBs), so the shadow matrix matches the
// eye-relative geometry and the shadow stays crisp and correctly placed.
//
// Paired BJS reference: lab/lite/src/bjs/scene207.ts (useLargeWorldRendering).
// Geometry, materials, camera, light and shadow config MUST stay in sync.

import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createEngine,
    createGround,
    createHemisphericLight,
    createPcfDirectionalShadowGenerator,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    registerSceneWithShadowSupport,
    setShadowTaskCasterMeshes,
    startEngine,
} from "babylon-lite";

const OFFSET = 5_000_000;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas, { useHighPrecisionMatrix: true, useFloatingOrigin: true });
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.05, b: 0.08, a: 1 };

    const cam = createArcRotateCamera(1.0, 0.62, 15, { x: OFFSET, y: 1, z: OFFSET });
    cam.nearPlane = 0.5;
    cam.farPlane = 500;
    scene.camera = cam;

    // Low hemispheric fill so shadowed faces aren't fully black (direction-only,
    // no floating-origin participation — matches the BJS HemisphericLight).
    const hemi = createHemisphericLight([0, 1, 0], 0.2);
    addToScene(scene, hemi);

    // The feature under test: a directional light whose shadow light-space
    // matrix is computed at large world coords. Position is set near the scene
    // (≈ OFFSET) so the eye-relative light view translation stays small/F32-safe.
    const light = createDirectionalLight([-1, -2, -1], 0.9);
    light.position.set(OFFSET + 20, 40, OFFSET + 20);
    light.diffuse = [1, 0.97, 0.9];
    addToScene(scene, light);

    // Casters first — their world AABBs feed the shadow frustum fit.
    const sphere = createSphere(engine, { diameter: 3, segments: 32 });
    const sphereMat = createStandardMaterial();
    sphereMat.diffuseColor = [0.8, 0.8, 0.85];
    sphereMat.specularColor = [0.4, 0.4, 0.4];
    sphere.material = sphereMat;
    sphere.position.set(OFFSET, 2, OFFSET);
    addToScene(scene, sphere);

    const casters = [sphere];
    const boxPositions: [number, number][] = [
        [-5, -4],
        [5, 4],
        [-4, 5],
    ];
    for (let i = 0; i < boxPositions.length; i++) {
        const [dx, dz] = boxPositions[i]!;
        const box = createBox(engine, 2);
        const boxMat = createStandardMaterial();
        boxMat.diffuseColor = [0.35 + i * 0.2, 0.45, 0.7 - i * 0.15];
        boxMat.specularColor = [0.3, 0.3, 0.3];
        box.material = boxMat;
        box.position.set(OFFSET + dx, 1, OFFSET + dz);
        addToScene(scene, box);
        casters.push(box);
    }

    // Ground receiver.
    const ground = createGround(engine, { width: 100, height: 100, subdivisions: 1 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.45, 0.45, 0.5];
    groundMat.specularColor = [0, 0, 0];
    ground.material = groundMat;
    ground.position.set(OFFSET, 0, OFFSET);
    ground.receiveShadows = true;
    addToScene(scene, ground);

    // PCF directional shadow — sphere + boxes are casters onto the ground.
    const sg = createPcfDirectionalShadowGenerator(engine, light, {
        mapSize: 1024,
        orthoMinZ: 1,
        orthoMaxZ: 200,
    });
    setShadowTaskCasterMeshes(sg, casters);
    light.shadowGenerator = sg;

    await registerSceneWithShadowSupport(engine, scene);
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
