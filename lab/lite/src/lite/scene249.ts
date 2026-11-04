// Scene 249 — VertexColorAlphaClipTest (cx20 gltf-test parity)
import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, loadEnvironment, loadGltf, attachControl, registerScene } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const root = await loadGltf(engine, "https://cx20.github.io/gltf-test/tutorialModels/VertexColorAlphaClipTest/glTF/VertexColorAlphaClipTest.gltf");
    addToScene(scene, root);

    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };
    await loadEnvironment(scene, "https://assets.babylonjs.com/environments/environmentSpecular.env", { skipSkybox: true, skipGround: true, brdfUrl: "/brdf-lut.png" });

    const cam = createArcRotateCamera(1.5707963, 1.5707963, 28.22, { x: 0, y: 0.728, z: 0 });
    cam.fov = 0.8;
    cam.nearPlane = 28.22 * 0.01;
    cam.farPlane = 28.22 * 1000;
    scene.camera = cam;
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
