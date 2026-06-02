// Scene 178 — Khronos IridescenceAbalone (KHR_materials_iridescence)
// Exercises glTF iridescenceFactor + packed intensity/thickness texture channels.

import { addToScene, attachControl, createArcRotateCamera, createBox, createEngine, createPbrMaterial, createSceneContext, createSolidTexture2D, loadEnvironment, loadGltf, onBeforeRender, registerScene, startEngine } from "babylon-lite";

const MODEL_URL = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/IridescenceAbalone/glTF-Binary/IridescenceAbalone.glb";
const ENV_URL = "https://assets.babylonjs.com/environments/studio.env";

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const camera = createArcRotateCamera(1.2, 1.25, 1.0, { x: 0, y: 0, z: 0 });
    camera.fov = 0.7;
    camera.nearPlane = 0.01;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    await Promise.all([
        loadGltf(engine, MODEL_URL).then((asset) => addToScene(scene, asset)),
        loadEnvironment(scene, ENV_URL, {
            brdfUrl: "/brdf-lut.png",
            skipGround: true,
            skipSkybox: true,
        }),
    ]);
    scene.imageProcessing.toneMappingEnabled = false;
    scene.imageProcessing.exposure = 1;
    scene.imageProcessing.contrast = 1;

    const skybox = createBox(engine, 50);
    skybox.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
        ormTexture: createSolidTexture2D(engine, 1, 0.3, 1),
        environmentIntensity: 1.014,
        directIntensity: 0,
        doubleSided: true,
        skyboxMode: true,
    });
    const syncSkybox = (): void => {
        const w = camera.worldMatrix;
        skybox.position.set(w[12]!, w[13]!, w[14]!);
    };
    syncSkybox();
    onBeforeRender(scene, syncSkybox);
    addToScene(scene, skybox);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
