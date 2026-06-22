// Scene 248 — TextureSettingsTest (cx20 gltf-test parity)
import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, loadEnvironment, loadGltf, attachControl, registerScene } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const root = await loadGltf(engine, "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/TextureSettingsTest/glTF/TextureSettingsTest.gltf");
    addToScene(scene, root);

    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };
    await loadEnvironment(scene, "https://assets.babylonjs.com/environments/environmentSpecular.env", { skipSkybox: true, skipGround: true, brdfUrl: "/brdf-lut.png" });

    const cam = createArcRotateCamera(1.5707963, 1.5707963, 21.64, { x: 0, y: -0.583, z: -0.025 });
    cam.fov = 0.8;
    cam.nearPlane = 21.64 * 0.01;
    cam.farPlane = 21.64 * 1000;
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
