// Scene 211 — Khronos BrainStem, EXT_meshopt_compression (+ KHR_mesh_quantization)
// Skinned + animated glTF whose vertex/animation buffers are meshopt-compressed
// and quantized. Both extensions are decoded in dynamic-imported loader features
// so non-meshopt scenes pay nothing. Frozen via ?seekTime for deterministic parity.

import { onBeforeRender, addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, loadGltf, createHemisphericLight, attachControl, goToFrame, pauseAnimation, registerScene } from "babylon-lite";

const MODEL_URL = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/BrainStem/glTF-Meshopt-EXT/BrainStem.gltf";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    addToScene(scene, await loadGltf(engine, MODEL_URL));

    const cam = createArcRotateCamera(Math.PI / 2, Math.PI / 2.2, 4.5, { x: -0.045, y: 0.043, z: 0.917 });
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    // Fixed timestep matching Babylon.js useConstantAnimationDeltaTime (16.0ms)
    scene.fixedDeltaMs = 16.0;

    const params = new URLSearchParams(window.location.search);
    const shouldFreeze = params.has("freeze");
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frameCount = 0;
    let seekDone = false;
    onBeforeRender(scene, () => {
        frameCount++;
        canvas.dataset.frameCount = String(frameCount);

        if (!isNaN(seekTimeParam) && seekTimeParam > 0 && frameCount === 10 && !seekDone) {
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
