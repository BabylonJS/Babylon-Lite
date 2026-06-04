// Scene 6: PBR Gold Sphere (Spec-Gloss) — matches Babylon #Z1VL3V#5
// PBRSpecularGlossinessMaterial equivalent via metallic-roughness:
//   diffuseColor = specularColor = gold, glossiness = 0.4
//   → metallic = 1.0, roughness = 0.6, baseColor = gold

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, createPbrMaterial, createSphere, createSolidTexture2D, loadEnvironment, attachControl, registerScene } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Camera: alpha=0, beta=π/2, radius=5, target=origin
    scene.camera = createArcRotateCamera(0, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    // Environment (same as Scene 1) — no explicit light, IBL only
    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        groundTextureUrl: "https://assets.babylonjs.com/core/environments/backgroundGround.png",
        skyboxUrl: "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds",
        skyboxSize: 1000,
        brdfUrl: "/brdf-lut.png",
    });

    // PBR material: spec-gloss equivalent via metallic-roughness
    // diffuseColor=gold, specularColor=gold, glossiness=0.4
    // → metallic=1.0, roughness=0.6, baseColor=gold
    const baseColorTex = createSolidTexture2D(engine, 1.0, 0.766, 0.336);
    const ormTex = createSolidTexture2D(engine, 1.0, 0.6, 1.0); // occ=1, rough=0.6, metal=1
    const material = createPbrMaterial({
        baseColorTexture: baseColorTex,
        ormTexture: ormTex,
    });

    // Sphere: segments=16, diameter=2 — assign PBR material
    const sphere = createSphere(engine, { segments: 16, diameter: 2 });
    sphere.material = material;
    addToScene(scene, sphere);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
