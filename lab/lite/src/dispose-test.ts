/** Dispose test — creates a scene, renders one frame, disposes everything,
 *  then recreates to prove no stale state. Tracks GPU errors via error scopes. */

import {
    disposeScene,
    addToScene,
    disposeEngine,
    stopEngine,
    startEngine,
    createEngine,
    createSceneContext,
    createDefaultCamera,
    createSphere,
    createStandardMaterial,
    registerScene,
} from "babylon-lite";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const gpuErrors: string[] = [];
(window as any).gpuErrors = gpuErrors;

async function createAndRender() {
    const engine = await createEngine(canvas);

    // Push an error scope to capture GPU validation errors
    engine._device.pushErrorScope("validation");

    const scene = createSceneContext(engine);
    const sphere = createSphere(engine);
    sphere.material = createStandardMaterial();
    addToScene(scene, sphere);
    createDefaultCamera(scene);

    // Render one frame
    await registerScene(engine, scene);
    await startEngine(engine);

    // Stop and wait a tick for GPU work to complete
    stopEngine(engine);
    await new Promise((r) => setTimeout(r, 100));

    // Check for GPU errors before dispose
    const preError = await engine._device.popErrorScope();
    if (preError) {
        gpuErrors.push("pre-dispose: " + preError.message);
    }

    // Push another scope for dispose
    engine._device.pushErrorScope("validation");

    // Dispose everything
    disposeScene(scene);
    disposeEngine(engine);

    return { engine, scene };
}

async function run() {
    try {
        // First create/dispose cycle
        await createAndRender();
        (window as any).disposed = true;

        // Second create/dispose cycle — proves no stale state
        const engine2 = await createEngine(canvas);
        engine2._device.pushErrorScope("validation");
        const scene2 = createSceneContext(engine2);
        const sphere2 = createSphere(engine2);
        sphere2.material = createStandardMaterial();
        addToScene(scene2, sphere2);
        createDefaultCamera(scene2);
        await registerScene(engine2, scene2);
        await startEngine(engine2);
        stopEngine(engine2);
        await new Promise((r) => setTimeout(r, 100));
        const err2 = await engine2._device.popErrorScope();
        if (err2) {
            gpuErrors.push("recreate: " + err2.message);
        }
        disposeScene(scene2);
        disposeEngine(engine2);

        (window as any).recreated = true;
        (window as any).ready = true;
        canvas.dataset.ready = "true";
    } catch (e: any) {
        gpuErrors.push("exception: " + e.message);
        (window as any).ready = true;
        canvas.dataset.ready = "true";
    }
}

void run();
