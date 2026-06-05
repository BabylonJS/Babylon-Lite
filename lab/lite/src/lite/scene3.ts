// Scene 3: Fog + Boxes — matches Babylon #7G0IQW

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, createPointLight, createBox, createStandardMaterial, loadSkybox, attachControl, registerScene, setFog } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(0.4, 1.2, 20, { x: -10, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 10000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    addToScene(scene, createPointLight([10, 50, 50]));

    setFog(scene, { mode: 1, density: 0.02, start: 0, end: 1000, color: [0.9, 0.9, 0.85] });

    const boxMat = createStandardMaterial();
    boxMat.diffuseColor = [1, 1, 0];

    for (let i = 0; i < 10; i++) {
        const box = createBox(engine);
        box.position.set(-i * 5, 0, 0);
        box.material = boxMat;
        addToScene(scene, box);
    }

    await loadSkybox(scene, "https://playground.babylonjs.com/textures/skybox", ".jpg");

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
