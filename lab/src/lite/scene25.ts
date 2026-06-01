// Scene 25: KTX Texture — matches Babylon #1SCH7H#182
// Ground plane with KTX compressed texture (auto-format selection), UV tiling, FreeCamera, hemispheric light.

import { addToScene, startEngine, createEngine, createSceneContext, createFreeCamera, attachFreeControl, createHemisphericLight, createGround, createStandardMaterial, loadKtxTexture2D, registerScene } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Camera: FreeCamera at (0, 5, -10) targeting origin
    const cam = createFreeCamera({ x: 0, y: 5, z: -10 }, { x: 0, y: 0, z: 0 });
    scene.camera = cam;
    attachFreeControl(cam, canvas, scene);

    // Light: hemispheric, intensity 0.7
    const light = createHemisphericLight([0, 1, 0], 0.7);
    addToScene(scene, light);

    // Ground: 6×6, 2 subdivisions
    const ground = createGround(engine, { width: 6, height: 6, subdivisions: 2 });
    const groundMat = createStandardMaterial();
    ground.material = groundMat;

    // Load texture with KTX compressed format selection + PNG fallback
    groundMat.diffuseTexture = await loadKtxTexture2D(
        engine,
        "https://raw.githubusercontent.com/Vinc3r/BJS-KTX-textures/master/BJS/UVgrid.png",
        ["-astc.ktx", "-dxt.ktx", "-etc2.ktx"]
    );
    groundMat.uvScale = [2, 2];

    addToScene(scene, ground);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
