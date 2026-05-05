// Scene 10: PBR Metallic-Roughness Sphere — matches Babylon #2FDQT5#12
// PBRMetallicRoughnessMaterial with golden color, metallic=0, roughness=1, hemispheric light only.

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, createHemisphericLight, createSphere, createPbrMaterial, createSolidTexture2D, registerScene } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(0, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    // PBR: baseColor=gold, metallic=0, roughness=1.0 (fully rough, non-metallic)
    const baseColorTex = createSolidTexture2D(engine, 1.0, 0.766, 0.336);
    const ormTex = createSolidTexture2D(engine, 1.0, 1.0, 0.0); // occ=1, rough=1, metal=0

    const sphere = createSphere(engine, { segments: 16, diameter: 2 });
    sphere.material = createPbrMaterial({
        baseColorTexture: baseColorTex,
        ormTexture: ormTex,
    });
    addToScene(scene, sphere);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
