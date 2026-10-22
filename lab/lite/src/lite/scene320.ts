// Scene 320 — Babylon.js visualization test "GLTF Serializer KHR draco mesh compression" (playground #F8BF8N#3).
// Alien.gltf is exported, the exported nodes are removed, and the GLB is loaded back into the same scene.
// Babylon Lite writes plain accessors (Draco output is out of scope), so the export carries no KHR_draco_mesh_compression.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    exportSceneAsGlb,
    loadGltf,
    registerScene,
    removeFromScene,
    startEngine,
} from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const source = await loadGltf(engine, "https://playground.babylonjs.com/scenes/Alien/Alien.gltf");
    addToScene(scene, source);

    // scene.createDefaultLight() / scene.createDefaultCamera(true, true, true) with the values Babylon.js computes for Alien.gltf
    // (alpha += Math.PI and radius = 1.25 applied). The snippet's shouldExportNode excludes lights and cameras from the export;
    // Lite has no export filter, so both are added to the scene only after the export.
    const camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 1.25, { x: 0.00019969046115875244, y: -0.24184994399547577, z: -0.03791956603527069 });
    camera.nearPlane = 0.02001863621551238;
    camera.farPlane = 2001.863621551238;
    attachControl(camera, canvas, scene);

    // exportThenImportAsync: export, dispose the exported nodes, load the file back into the scene.
    const glb = await exportSceneAsGlb(scene);
    removeFromScene(scene, source);
    addToScene(scene, await loadGltf(engine, glb));

    scene.camera = camera;
    addToScene(scene, createHemisphericLight([0, 1, 0], 1));

    // Fixed timestep matching Babylon.js useConstantAnimationDeltaTime (16.0ms)
    scene.fixedDeltaMs = 16.0;

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
});
