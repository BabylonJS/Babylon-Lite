// Scene 243 — MorphStressTest (cx20 gltf-test parity)
import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, loadEnvironment, loadGltf, attachControl, registerScene, onBeforeRender, goToFrame, pauseAnimation } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const root = await loadGltf(engine, "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/MorphStressTest/glTF/MorphStressTest.gltf");
    addToScene(scene, root);

    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };
    await loadEnvironment(scene, "https://assets.babylonjs.com/environments/environmentSpecular.env", { skipSkybox: true, skipGround: true, brdfUrl: "/brdf-lut.png" });

    const cam = createArcRotateCamera(1.5707963, 1.5707963, 6.25, { x: 0, y: 0.2, z: 0 });
    cam.fov = 0.8;
    cam.nearPlane = 6.25 * 0.01;
    cam.farPlane = 6.25 * 1000;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    scene.fixedDeltaMs = 16.0;
    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frameCount = 0;
    let seekDone = false;
    onBeforeRender(scene, () => {
        frameCount++;
        if (!isNaN(seekTimeParam) && frameCount === 10 && !seekDone) {
            const seekFrame = seekTimeParam * 60;
            for (const g of scene.animationGroups) {
                goToFrame(g, seekFrame);
                pauseAnimation(g);
            }
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
    (window as any).__scene = scene;
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
