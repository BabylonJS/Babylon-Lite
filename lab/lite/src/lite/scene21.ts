// Scene 21: PBR Sheen Cloth — blue cloth with sheen + country.env
// Matches BJS playground: cloth mesh with PBR sheen material.
// Static model, no animation.

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, attachControl, loadEnvironment, loadGltf, createPbrMaterial, createSolidTexture2D, loadTexture2D, registerScene } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Camera matching BJS: alpha=-PI/2, beta=PI/2.7, radius=0.14
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.7, 0.14, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 0.01;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    // Load cloth GLB + environment + sheen texture in parallel
    const [gltfResult, , sheenTex2D] = await Promise.all([
        loadGltf(engine, "https://models.babylonjs.com/cloth/cloth_meshV1.glb"),
        loadEnvironment(scene, "https://playground.babylonjs.com/textures/country.env", {
            brdfUrl: "/brdf-lut.png",
            skyboxUrl: "https://playground.babylonjs.com/textures/country.env",
            skipGround: true,
        }),
        loadTexture2D(engine, "https://playground.babylonjs.com/textures/fire.png", { invertY: false }),
    ]);
    addToScene(scene, gltfResult);

    // BJS scene uses createDefaultSkybox (NOT createDefaultEnvironment),
    // so no image processing is applied. Override the defaults set by loadEnvironment.
    scene.imageProcessing.toneMappingEnabled = false;
    scene.imageProcessing.exposure = 1.0;
    scene.imageProcessing.contrast = 1.0;

    // PBR material matching BJS: metallic=0, roughness=0.8, blue albedo, sheen enabled
    const baseColorTex = createSolidTexture2D(engine, 12 / 255, 60 / 255, 222 / 255);
    const ormTex = createSolidTexture2D(engine, 1.0, 0.8, 0.0); // occlusion=1, roughness=0.8, metallic=0

    const sheenMat = createPbrMaterial({
        baseColorTexture: baseColorTex,
        ormTexture: ormTex,
        sheen: {
            isEnabled: true,
            color: [1, 1, 1],
            roughness: 0.5,
            intensity: 1.0,
            texture: sheenTex2D,
        },
    });

    // Apply sheen material to all meshes (matching BJS: all non-skybox meshes get mat0)
    for (const m of scene.meshes) {
        m.material = sheenMat;
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
