// Scene 2: Sphere + DirectionalLight — matches Babylon #20OAV9#1

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createDirectionalLight,
    createSphere,
    createStandardMaterial,
    attachControl,
    registerScene,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 10000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    const light = createDirectionalLight([0, -1, 0]);
    light.diffuse = [1, 0, 0];
    light.specular = [0, 1, 0];
    addToScene(scene, light);

    const sphere = createSphere(engine);
    sphere.material = createStandardMaterial();
    addToScene(scene, sphere);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
