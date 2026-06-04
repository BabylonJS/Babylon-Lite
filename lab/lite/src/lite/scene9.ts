import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, attachControl, loadBabylon, registerScene } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    addToScene(scene, await loadBabylon(engine, "https://www.babylonjs.com/Scenes/Sponza/Sponza.babylon", { loadCamera: false }));

    // Arc-rotate camera: same params used in BJS reference for parity
    scene.camera = createArcRotateCamera(
        0, // alpha — looking down +X
        Math.PI / 2.2, // beta  — slightly above horizon
        0.01, // radius — nearly at target (first-person view)
        { x: 5.0855, y: 2.492, z: 0.1654 }
    );
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 10000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
