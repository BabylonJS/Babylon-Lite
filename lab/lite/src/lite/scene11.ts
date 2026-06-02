// Scene 11: Shark GLB — matches Babylon #ISZ7Y2#98
// Animated shark model, rotated camera to show the side profile.
// Only plays the "swimming" animation for deterministic parity.

import { onBeforeRender, addToScene, startEngine, createEngine, createSceneContext, createDefaultCamera, createHemisphericLight, loadGltf, attachControl, stopAnimation, goToFrame, pauseAnimation, registerScene } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.14, g: 0.14, b: 0.14, a: 1.0 };

    addToScene(scene, await loadGltf(engine, "https://models.babylonjs.com/shark.glb"));

    // Only play "swimming" animation (stop circling + bite)
    for (const g of scene.animationGroups) {
        if (g.name !== "swimming") {
            stopAnimation(g);
        }
    }

    const cam = createDefaultCamera(scene);
    cam.alpha = 0; // 90° from default: side view
    cam.beta = Math.PI / 2.2; // slight elevation
    attachControl(cam, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    // Fixed timestep for deterministic animation (matches BJS useConstantAnimationDeltaTime)
    scene.fixedDeltaMs = 16.0;

    // Freeze animation for parity tests (triggered by ?freeze or ?seekTime query param)
    const params = new URLSearchParams(window.location.search);
    const shouldFreeze = params.has("freeze");
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frameCount = 0;
    let seekDone = false;
    onBeforeRender(scene, () => {
        frameCount++;
        canvas.dataset.frameCount = String(frameCount);

        if (!isNaN(seekTimeParam) && seekTimeParam >= 0 && frameCount === 10 && !seekDone) {
            const seekFrame = seekTimeParam * 60;
            for (const g of scene.animationGroups) {
                goToFrame(g, seekFrame);
            }
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
        }

        if (shouldFreeze && !seekDone && frameCount === 300) {
            for (const g of scene.animationGroups) {
                pauseAnimation(g);
            }
            canvas.dataset.animationFrozen = "true";
        }
    });

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
