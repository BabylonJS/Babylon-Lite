// Scene 15: Two SpotLights + Ground — demonstrates multi-light support.
// Matches Babylon playground #20OAV9#3.

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, createSpotLight, createGround, createStandardMaterial, attachControl, registerScene } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 4, 5, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 10000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    // Red spot light — slow decay (exponent 10)
    const spot0 = createSpotLight([-1, 1, -1], [0, -1, 0], Math.PI / 2, 10);
    spot0.diffuse = [1, 0, 0];
    spot0.specular = [0, 1, 0];
    addToScene(scene, spot0);

    // Green spot light — fast decay (exponent 50)
    const spot1 = createSpotLight([1, 1, 1], [0, -1, 0], Math.PI / 2, 50);
    spot1.diffuse = [0, 1, 0];
    spot1.specular = [0, 1, 0];
    addToScene(scene, spot1);

    const ground = createGround(engine, { width: 4, height: 4 });
    ground.material = createStandardMaterial();
    addToScene(scene, ground);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
