// Scene 265 — EnvironmentTest (cx20 gltf-test parity).
// Exercises EXT_lights_image_based: the glTF carries its own image-based light
// (irradiance SH9 + prefiltered specular cubemap), so we do NOT call
// loadEnvironment — the extension installs the environment onto the scene.
import { addToScene, startEngine, createEngine, createSceneContext, createDefaultCamera, loadGltf, attachControl, registerScene } from "babylon-lite";

const MODEL_URL = "https://cx20.github.io/gltf-test/tutorialModels/EnvironmentTest/glTF-IBL/EnvironmentTest.gltf";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    const root = await loadGltf(engine, MODEL_URL);
    addToScene(scene, root);

    const cam = createDefaultCamera(scene);
    cam.alpha = Math.PI / 2;
    cam.beta = Math.PI / 2.5;
    attachControl(cam, canvas, scene);

    await registerScene(scene);
    await startEngine(engine);
    (window as any).__scene = scene;
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
