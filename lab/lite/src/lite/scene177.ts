// Scene 177 — PBR Iridescence Sphere
// Port of https://playground.babylonjs.com/#2FDQT5#1505:
// metallic black PBR sphere with default BJS iridescence and environment.env.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    createSphere,
    loadEnvironment,
    onBeforeRender,
    registerScene,
    startEngine,
} from "babylon-lite";

const ENV_URL = "https://playground.babylonjs.com/textures/environment.env";

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const camera = createArcRotateCamera(0, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    await loadEnvironment(scene, ENV_URL, {
        brdfUrl: "/brdf-lut.png",
        skipGround: true,
        skipSkybox: true,
    });
    scene.imageProcessing.toneMappingEnabled = false;
    scene.imageProcessing.exposure = 1;
    scene.imageProcessing.contrast = 1;

    const sphere = createSphere(engine, { segments: 16, diameter: 2 });
    sphere.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.1, 0.1, 0.1),
        ormTexture: createSolidTexture2D(engine, 1, 0, 1),
        iridescence: {
            isEnabled: true,
        },
    });
    addToScene(scene, sphere);

    const skybox = createBox(engine, 1000);
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
