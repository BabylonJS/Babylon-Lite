import {
    onBeforeRender,
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createDefaultCamera,
    loadGltf,
    createHemisphericLight,
    attachControl,
    goToFrame,
    pauseAnimation,
    registerScene,
} from "babylon-lite";
import { enableDeviceLostRecovery } from "babylon-lite/engine/device-lost-recovery";
import { forceWebGpuDeviceLossForTesting } from "babylon-lite/engine/device-lost-recovery-testing";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    enableDeviceLostRecovery(engine, {
        onLost() {
            canvas.dataset.deviceLost = "true";
        },
        onRecovered() {
            canvas.dataset.deviceRecovered = "true";
        },
        onRecoveryFailed(error) {
            canvas.dataset.recoveryFailed = error instanceof Error ? error.message : String(error);
        },
    });
    const scene = createSceneContext(engine);

    addToScene(scene, await loadGltf(engine, "https://playground.babylonjs.com/scenes/Alien/Alien.gltf"));

    const cam = createDefaultCamera(scene);
    cam.alpha = Math.PI / 2;
    cam.beta = Math.PI / 2;
    cam.radius = 2;
    cam.target = { x: 0, y: 0, z: 0 };
    attachControl(cam, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.7));
    scene.fixedDeltaMs = 16.0;

    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "2");
    let frameCount = 0;
    let recoveredFrames = 0;
    let frozen = false;
    onBeforeRender(scene, () => {
        frameCount++;
        canvas.dataset.frameCount = String(frameCount);
        if (canvas.dataset.deviceRecovered === "true" && !frozen) {
            recoveredFrames++;
            canvas.dataset.postRecoveryFrames = String(recoveredFrames);
            if (recoveredFrames >= 10) {
                const seekFrame = (isNaN(seekTimeParam) ? 2 : seekTimeParam) * 60;
                for (const g of scene.animationGroups) {
                    goToFrame(g, seekFrame);
                    pauseAnimation(g);
                }
                frozen = true;
                canvas.dataset.animationFrozen = "true";
                canvas.dataset.ready = "true";
            }
        }
    });

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.loaded = "true";
    canvas.dataset.ready = "true";
    forceWebGpuDeviceLossForTesting(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
}

main().catch(console.error);
