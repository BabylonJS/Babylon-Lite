// Scene 62: NME diffuse texture — sphere with a crate texture on black background.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createSphere,
    attachControl,
    registerScene,
    parseNodeMaterialFromSnippet,
    loadTexture2D,
} from "babylon-lite";
import { SCENE62_NME_JSON, SCENE62_TEXTURE_URL } from "../shared/scene62-nme.js";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 10000;
    attachControl(scene.camera, canvas, scene);

    const diffuse = await loadTexture2D(engine, SCENE62_TEXTURE_URL);
    const material = await parseNodeMaterialFromSnippet(engine, "", {
        json: SCENE62_NME_JSON,
        textures: { diffuse },
    });

    const sphere = createSphere(engine);
    (sphere as { material?: unknown }).material = material;
    addToScene(scene, sphere);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
