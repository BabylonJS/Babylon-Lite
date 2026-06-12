// Scene 23: PBR Anisotropy — metallic sphere with anisotropic reflections
// Based on playground #FEEK7G#1175

import { addToScene, startEngine, onBeforeRender, createEngine, createSceneContext, createArcRotateCamera, attachControl, createSphere, createPbrMaterial, createSolidTexture2D, loadEnvironment, registerScene } from "babylon-lite";
import { installPbrTracking } from "babylon-lite/material/tracking/pbr-tracking";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Camera: alpha=0, beta=π/2, radius=5, target=origin
    const cam = createArcRotateCamera(0, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    // seekTime support for parity testing
    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");

    // Compute initial anisotropy intensity from seekTime
    // Playground animates: a += 0.01 per frame, intensity = cos(a)*0.5+0.5
    let a = 0;
    if (!isNaN(seekTimeParam) && seekTimeParam > 0) {
        const seekFrames = seekTimeParam * 60;
        a = seekFrames * 0.01;
    }
    const initialIntensity = Math.cos(a) * 0.5 + 0.5;

    // PBR material: metallic=1.0, roughness=0.0 (perfect mirror) with anisotropy
    const baseColorTex = createSolidTexture2D(engine, 1.0, 1.0, 1.0);
    const ormTex = createSolidTexture2D(engine, 1.0, 0.0, 1.0); // occ=1, rough=0, metal=1

    const material = createPbrMaterial({
        baseColorTexture: baseColorTex,
        ormTexture: ormTex,
        anisotropy: {
            isEnabled: true,
            intensity: initialIntensity,
            direction: [1, 0],
        },
    });
    installPbrTracking(material);

    // Sphere: 128 segments, diameter 2
    const sphere = createSphere(engine, { segments: 128, diameter: 2 });
    sphere.material = material;
    addToScene(scene, sphere);

    // Environment (IBL only, no direct light)
    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        groundTextureUrl: "https://assets.babylonjs.com/core/environments/backgroundGround.png",
        skyboxUrl: "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds",
        brdfUrl: "/brdf-lut.png",
    });

    if (!isNaN(seekTimeParam)) {
        canvas.dataset.animationFrozen = "true";
    }

    // Animate anisotropy intensity per-frame (matches BJS playground: a += 0.01; intensity = cos(a)*0.5+0.5)
    if (isNaN(seekTimeParam)) {
        onBeforeRender(scene, () => {
            a += 0.01;
            material.anisotropy!.intensity = Math.cos(a) * 0.5 + 0.5;
        });
    }

    await registerScene(scene);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

void main();
