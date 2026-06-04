// Scene 212 — DispersionTest (KHR transmission + ior + volume + dispersion)
// Reproduces the Babylon.js view of the Khronos DispersionTest model against
// the studio.env HDR environment (IBL + blurred HDR skybox), with frame-graph
// scene-texture transmission for the translucent prisms. KHR_materials_dispersion
// splits the refracted ray per RGB channel (chromatic aberration).
// Static camera (no auto-rotation) for a deterministic golden.

import {
    addToScene, attachControl, createArcRotateCamera, createBox, createEngine, createPbrMaterial,
    createSceneContext, createSolidTexture2D, getFrameGraph, loadEnvironment, loadGltf,
    onBeforeRender, registerScene, startEngine,
    type RenderTask,
} from "babylon-lite";

const MODEL_URL = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/DispersionTest/glTF-Binary/DispersionTest.glb";
const ENV_URL = "https://assets.babylonjs.com/environments/studio.env";

// Fixed face-on camera pose (mirrored exactly in src/bjs/scene212.ts) so both
// renders use an identical view independent of auto-framing.
const CAM = {
    alpha: Math.PI / 2,
    beta: Math.PI / 2,
    radius: 0.13,
    target: { x: 0, y: 0, z: 0 },
    fov: 0.8,
};

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    // Transmissive prisms require the frame-graph scene-texture transmission copy.
    (getFrameGraph(scene)._tasks[0] as RenderTask)._config.transmission = { copyCount: 1 };

    const cam = createArcRotateCamera(CAM.alpha, CAM.beta, CAM.radius, CAM.target);
    cam.fov = CAM.fov;
    cam.nearPlane = CAM.radius * 0.01;
    cam.farPlane = CAM.radius * 1000;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    await Promise.all([
        loadGltf(engine, MODEL_URL).then((asset) => addToScene(scene, asset)),
        loadEnvironment(scene, ENV_URL, {
            // IBL only — the visible skybox is a scene-level blurred PBR box below
            // (mirrors BJS createDefaultSkybox(env, true, scale, 0.3) = microSurface 0.7).
            skipSkybox: true,
            skipGround: true,
            brdfUrl: "/brdf-lut.png",
        }),
    ]);

    // Match the BJS image processing: linear output (no tone mapping), neutral
    // exposure/contrast. Set before registerScene so the deferred skybox build
    // snapshots these values.
    scene.imageProcessing.toneMappingEnabled = false;
    scene.imageProcessing.exposure = 1.0;
    scene.imageProcessing.contrast = 1.0;

    // Blurred HDR skybox mirroring BJS createDefaultSkybox(env, true, scale, 0.3, false):
    // a PBR skybox-mode box with microSurface 0.7 (= roughness 0.3), F0=(1,1,1) via
    // metallic=1 + white base colour, no direct lighting. Samples the IBL cube along
    // the view ray, so it both shows as the background and renders into the
    // transmission scene copy.
    const skybox = createBox(engine, (cam.farPlane - cam.nearPlane) / 2);
    skybox.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
        ormTexture: createSolidTexture2D(engine, 1.0, 0.3, 1.0), // occ=1, rough=0.3, metal=1
        environmentIntensity: 1.0,
        directIntensity: 0,
        doubleSided: true,
        skyboxMode: true,
    });
    const syncSkybox = (): void => {
        const w = cam.worldMatrix;
        skybox.position.set(w[12]!, w[13]!, w[14]!);
    };
    syncSkybox();
    onBeforeRender(scene, syncSkybox);
    addToScene(scene, skybox);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camBeta = String(cam.beta);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.camTarget = `${cam.target.x},${cam.target.y},${cam.target.z}`;
    canvas.dataset.camFov = String(cam.fov);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
