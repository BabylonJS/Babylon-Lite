// Scene 110 - RTT with per-pass material override.
//
// Two meshes A (sphere) and B (box) are added to the main pass with the standard pipeline.
// A second render pass R1 renders mesh A only, with its own camera and a different
// green material, into an offscreen 512x512 color texture. That texture is wired as
// mesh B's diffuseTexture, so the box on screen displays whatever R1 rendered.
//
// Demonstrates: addMesh, addTaskAtStart, createRenderTargetTexture,
// per-pass material override, and that one Renderable per (mesh, material) is shared
// across multiple passes.

import {
    addTaskAtStart,
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createFreeCamera,
    createHemisphericLight,
    createRenderTask,
    createRenderTargetTexture,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    registerScene,
    startEngine,
} from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Main camera: orbit around the two meshes.
    const mainCam = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.5, 8, { x: 1.5, y: 0, z: 0 });
    mainCam.nearPlane = 0.1;
    mainCam.farPlane = 100;
    scene.camera = mainCam;
    attachControl(mainCam, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0]));

    // R1 render target is eagerly allocated so its color view can be wired as
    // B's diffuseTexture before the frame graph is built.
    const { rt: r1RT, texture: r1Tex } = createRenderTargetTexture(engine, {
        lbl: "r1",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: 1,
        size: { width: 512, height: 512 },
    });

    // Mesh A: sphere with red main-pass material.
    const meshA = createSphere(engine);
    const matA_R0 = createStandardMaterial();
    matA_R0.diffuseColor = [1, 0.2, 0.2];
    meshA.material = matA_R0;
    addToScene(scene, meshA);

    // Mesh B: box with diffuseTexture = R1's color attachment.
    const meshB = createBox(engine, 2);
    meshB.position.x = 3;
    const matB = createStandardMaterial();
    matB.diffuseTexture = r1Tex;
    meshB.material = matB;
    addToScene(scene, meshB);

    // R1 task: its own camera, only mesh A, runs before main so its texture is ready.
    const r1Cam = createFreeCamera({ x: 0, y: 0, z: -3 }, { x: 0, y: 0, z: 0 });
    r1Cam.nearPlane = 0.1;
    r1Cam.farPlane = 100;
    const r1Task = createRenderTask({ name: "r1", rt: r1RT, clrColor: { r: 0.1, g: 0.1, b: 0.3, a: 1 }, cam: r1Cam, cs: true }, engine, scene);
    addTaskAtStart(scene, r1Task);

    // Override material for A in R1: green sphere on a blue background.
    const matA_R1 = createStandardMaterial();
    matA_R1.diffuseColor = [0.2, 1, 0.2];
    r1Task.addMesh(meshA, { material: matA_R1 });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
