// Scene 110 — RTT with per-pass material override.
//
// Two meshes A (sphere) and B (box) are added to the main pass with the standard pipeline.
// A second render pass R1 renders mesh A *only*, with its own camera AND a different
// (green) material, into an offscreen 512x512 color texture. That texture is wired as
// mesh B's diffuseTexture, so the box on screen displays whatever R1 rendered.
//
// Demonstrates: addToPass, addTaskAtStart, createRenderTargetTexture,
// per-pass material override, and that one Renderable per (mesh, material) is shared
// across multiple passes.
//
// Note: id 110 — moved from id 52.

import {
    addToScene,
    startEngine,
    registerScene,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createFreeCamera,
    createHemisphericLight,
    createSphere,
    createBox,
    createStandardMaterial,
    attachControl,
    addTaskAtStart,
    createRenderPassTask,
    createRenderTargetTexture,
} from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Main camera — orbit around the two meshes
    const mainCam = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.5, 8, { x: 1.5, y: 0, z: 0 });
    mainCam.nearPlane = 0.1;
    mainCam.farPlane = 100;
    scene.camera = mainCam;
    attachControl(mainCam, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0]));

    // R1 render target — eagerly allocated so we can wire its color view as B's diffuseTexture
    // BEFORE the frame graph is built. Fixed 512x512 (RTT size is independent of canvas).
    const { rt: r1RT, texture: r1Tex } = createRenderTargetTexture(engine, {
        label: "r1",
        colorFormat: engine.format,
        depthStencilFormat: "depth24plus-stencil8",
        sampleCount: 1,
        size: { width: 512, height: 512 },
    });

    // Mesh A — sphere with red main material
    const meshA = createSphere(engine);
    const matA_R0 = createStandardMaterial();
    matA_R0.diffuseColor = [1, 0.2, 0.2];
    meshA.material = matA_R0;
    addToScene(scene, meshA);

    // Mesh B — box with diffuseTexture = R1's color attachment
    const meshB = createBox(engine, 2);
    meshB.position.x = 3;
    const matB = createStandardMaterial();
    matB.diffuseTexture = r1Tex;
    meshB.material = matB;
    addToScene(scene, meshB);

    // R1 task — its own camera, only mesh A, runs BEFORE main so its texture is ready.
    const r1Cam = createFreeCamera({ x: 0, y: 0, z: -3 }, { x: 0, y: 0, z: 0 });
    r1Cam.nearPlane = 0.1;
    r1Cam.farPlane = 100;
    const r1Task = createRenderPassTask({ name: "r1", rt: r1RT, clrColor: { r: 0.1, g: 0.1, b: 0.3, a: 1 }, cam: r1Cam, cs: true }, engine, scene);
    addTaskAtStart(scene, r1Task);

    // Override material for A in R1 — green sphere on a blue background.
    const matA_R1 = createStandardMaterial();
    matA_R1.diffuseColor = [0.2, 1, 0.2];
    r1Task.addToPass(meshA, { material: matA_R1 });

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
