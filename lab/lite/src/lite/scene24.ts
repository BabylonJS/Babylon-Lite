// Scene 24: Hill Valley (.babylon) — pre-baked lighting, standard materials
// Based on playground #TJIGQ1#349

import { addToScene, startEngine, createEngine, createSceneContext, attachFreeControl, loadBabylon, registerScene } from "babylon-lite";
import type { FreeCamera } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Camera is parsed from the .babylon file and set as scene.camera by addToScene
    addToScene(scene, await loadBabylon(engine, "https://www.babylonjs.com/Scenes/hillvalley/HillValley.babylon"));

    attachFreeControl(scene.camera as FreeCamera, canvas, scene);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
