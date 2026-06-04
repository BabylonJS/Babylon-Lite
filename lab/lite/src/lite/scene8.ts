// Scene 8: HDR Glass Sphere — matches Babylon #19JGPR#13
// PBR glass sphere with HDR environment, alpha transparency, and custom exposure/contrast.

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, createSphere, createPbrMaterial, createSolidTexture2D, createPointLight, loadHdrEnvironment, attachControl, registerScene } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Camera: matches playground exactly
    scene.camera = createArcRotateCamera(-Math.PI / 4, Math.PI / 2.5, 200, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 0.1;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    // Point light at (0, 40, 0) — matches playground
    const light = createPointLight({ x: 0, y: 40, z: 0 } as unknown as [number, number, number]);
    addToScene(scene, light);

    // HDR environment — loads room.hdr panorama, creates cubemap + prefiltered IBL
    await loadHdrEnvironment(scene, "https://playground.babylonjs.com/textures/room.hdr", {
        faceSize: 512,
        useCubemapSkybox: true,
        skipGround: true,
    });

    // Override exposure/contrast to match playground
    scene.imageProcessing.exposure = 0.66;
    scene.imageProcessing.contrast = 1.66;

    // Glass sphere: segments=48, diameter=80
    // roughness=0 (microSurface=1), metallic=0, F0=0.2, envIntensity=0.7, directIntensity=0
    const baseColorTex = createSolidTexture2D(engine, 0.95, 0.95, 0.95, 1.0);
    const ormTex = createSolidTexture2D(engine, 1.0, 0.0, 0.0); // occ=1, rough=0, metal=0
    const sphere = createSphere(engine, { segments: 48, diameter: 80 });
    sphere.material = createPbrMaterial({
        baseColorTexture: baseColorTex,
        ormTexture: ormTex,
        alpha: 0.5,
        environmentIntensity: 0.7,
        directIntensity: 0.0,
        reflectance: 0.2,
    });
    addToScene(scene, sphere);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
