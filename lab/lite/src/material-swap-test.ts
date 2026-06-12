/** Material swap test — creates a sphere, renders it red, swaps to green,
 *  reports colors back to the test runner via window globals. */

import { onBeforeRender, addToScene, startEngine, createEngine, createSceneContext, createDefaultCamera, createSphere, createStandardMaterial, createHemisphericLight, registerScene } from "babylon-lite";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
(window as any).testResult = "pending";
(window as any).phase = "init";

async function run() {
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const light = createHemisphericLight([0, 1, 0], 1.0);
    addToScene(scene, light);

    const sphere = createSphere(engine, { diameter: 2, segments: 16 });
    const redMat = createStandardMaterial();
    redMat.diffuseColor = [1, 0, 0];
    redMat.emissiveColor = [0.5, 0, 0];
    sphere.material = redMat;
    addToScene(scene, sphere);

    createDefaultCamera(scene);
    await registerScene(scene);
    await startEngine(engine);

    // Wait a few frames for red to be visible
    await new Promise((r) => setTimeout(r, 200));
    (window as any).phase = "red";

    // Wait for the test to take a screenshot of red, then swap to green
    await new Promise<void>((resolve) => {
        (window as any).swapToGreen = () => {
            const greenMat = createStandardMaterial();
            greenMat.diffuseColor = [0, 1, 0];
            greenMat.emissiveColor = [0, 0.5, 0];
            sphere.material = greenMat;

            // The material swap may require a lazy module import (async).
            // Poll via onBeforeRender until the rebuild module is loaded
            // (_rebuildSingle exists) and the swap queue is fully drained.
            let signaled = false;
            onBeforeRender(scene, () => {
                if (signaled) {
                    return;
                }
                const builder = (greenMat as any)._buildGroup;
                if (builder?._rebuildSingle && (scene as unknown as { _materialSwapQueue: unknown[] })._materialSwapQueue.length === 0) {
                    signaled = true;
                    (window as any).phase = "green";
                    resolve();
                }
            });
        };
    });

    canvas.dataset.ready = "true";
}

run().catch((e) => {
    (window as any).testResult = "error: " + e.message;
    (window as any).phase = "error";
    canvas.dataset.ready = "true";
});
