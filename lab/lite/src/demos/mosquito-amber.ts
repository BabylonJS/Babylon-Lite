// MosquitoInAmber (KHR transmission + ior + volume)
// Reproduces the Babylon.js sandbox view of the Khronos MosquitoInAmber model
// against the studio.env HDR environment (used as both IBL and a visible HDR
// skybox), with frame-graph scene-texture transmission for the translucent amber.
// Static camera (no auto-rotation).

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    loadEnvironment,
    loadGltf,
    onBeforeRender,
    registerScene,
    setCameraLimits,
    startEngine,
} from "babylon-lite";
import { configureDemoDecoderBases, demoAssetUrl } from "./demo-asset-url.js";
import { installFetchProgress } from "./loading-progress.js";

const MODEL_URL = "https://assets.babylonjs.com/meshes/MosquitoInAmber/glTF/MosquitoInAmber.gltf";
const ENV_URL = "https://assets.babylonjs.com/environments/studio.env";

// Fixed camera pose framing the amber from the sandbox cameraPosition
// (-0.14, 0.005, 0.03) relative to the auto-framed model centre. Hardcoded here
// so the render uses a consistent view independent of auto-framing.
const CAM = {
    alpha: 1.9445,
    beta: 1.5454,
    radius: 0.1458,
    target: { x: 0.00098, y: 0.0013, z: -0.00713 },
    fov: 0.8,
};

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const progress = installFetchProgress(canvas, { estimatedBytes: 24_500_000 });

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const cam = createArcRotateCamera(CAM.alpha, CAM.beta, CAM.radius, CAM.target);
    cam.fov = CAM.fov;
    cam.nearPlane = CAM.radius * 0.01;
    cam.farPlane = CAM.radius * 1000;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    // Keep the inspect gesture sane: bound pinch/wheel zoom around the framed pose
    // so the amber can't be zoomed inside-out or shrunk to a speck.
    setCameraLimits(
        cam,
        {
            lowerRadiusLimit: CAM.radius * 0.4,
            upperRadiusLimit: CAM.radius * 2.5,
        },
        scene,
    );

    await configureDemoDecoderBases(import.meta.url);

    await Promise.all([
        loadGltf(engine, MODEL_URL).then((asset) => addToScene(scene, asset)),
        loadEnvironment(scene, ENV_URL, {
            // IBL only — the visible skybox is a scene-level blurred PBR box below
            // (mirrors BJS createDefaultSkybox(env, true, scale, 0.3) = microSurface 0.7).
            skipSkybox: true,
            skipGround: true,
            brdfUrl: demoAssetUrl("./brdf-lut.png", import.meta.url),
        }),
    ]);

    // Match the Babylon.js sandbox image processing for this model: linear output
    // (no tone mapping), neutral exposure/contrast. Set before registerScene so the
    // deferred skybox build snapshots these values.
    scene.imageProcessing.toneMappingEnabled = false;
    scene.imageProcessing.exposure = 1.0;
    scene.imageProcessing.contrast = 1.0;

    // Blurred HDR skybox built at the scene level (no engine change), mirroring
    // BJS createDefaultSkybox(env, true, scale, 0.3, false): a PBR skybox-mode box
    // with microSurface 0.7 (= roughness 0.3), F0=(1,1,1) via metallic=1 + white
    // base colour, no direct lighting. Samples the IBL cube along the view ray, so
    // it both shows as the background and renders into the transmission scene copy.
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

    await registerScene(scene);
    progress.done();
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
