// Scene 322 — Babylon.js visualization test "GLTF Serializer KHR gpu instancing" (playground #1Q2BWN#10).
// TeapotsGalore.gltf is loaded into a scene, exported to GLB, and the GLB is loaded into a new scene that gets its own
// camera and light. Only the reloaded scene is rendered (the harness renders the returned `outScene`).

import {
    addToScene,
    attachFreeControl,
    createEngine,
    createFreeCamera,
    createHemisphericLight,
    createSceneContext,
    exportSceneAsGlb,
    loadGltf,
    registerScene,
    startEngine,
} from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const cameraLocation = { x: 0, y: 50, z: -100 };
    const cameraTarget = { x: 0, y: 0, z: 0 };

    // The source scene (never rendered): camera, hemispheric light (intensity 0.7) and the TeapotsGalore thin instances.
    const scene = createSceneContext(engine);
    scene.camera = createFreeCamera({ ...cameraLocation }, { ...cameraTarget });
    addToScene(scene, createHemisphericLight([0, 1, 0], 0.7));
    addToScene(scene, await loadGltf(engine, "https://models.babylonjs.com/TeapotsGalore/TeapotsGalore.gltf"));

    const glb = await exportSceneAsGlb(scene);

    // The reloaded scene (rendered): the GLB plus a new camera and light, like the snippet's `outScene`.
    const outScene = createSceneContext(engine);
    addToScene(outScene, await loadGltf(engine, glb));
    const camera = createFreeCamera({ ...cameraLocation }, { ...cameraTarget });
    outScene.camera = camera;
    attachFreeControl(camera, canvas, outScene);
    addToScene(outScene, createHemisphericLight([0, 1, 0], 0.7));

    // Fixed timestep matching Babylon.js useConstantAnimationDeltaTime (16.0ms)
    outScene.fixedDeltaMs = 16.0;

    await registerScene(outScene);
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
