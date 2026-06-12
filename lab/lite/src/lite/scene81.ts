// Scene 81: NME UV/projection mapping blocks.

import { addToScene, attachControl, createArcRotateCamera, createEngine, createSceneContext, createSphere, loadTexture2D, parseNodeMaterialFromSnippet, registerScene, startEngine } from "babylon-lite";
import { SCENE81_NME_JSON, SCENE81_TEXTURE_URL } from "../shared/scene81-nme.js";

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(-Math.PI * 0.42, Math.PI * 0.42, 4.2, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.25;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const atlas = await loadTexture2D(engine, SCENE81_TEXTURE_URL, {
        mipMaps: false,
        minFilter: "nearest",
        magFilter: "nearest",
    });
    const material = await parseNodeMaterialFromSnippet(engine, "", {
        json: SCENE81_NME_JSON,
        textures: { AtlasUV: atlas, TriAtlas: atlas, BiAtlas: atlas },
    });

    const sphere = createSphere(engine, { segments: 48, diameter: 2.6 });
    sphere.material = material;
    addToScene(scene, sphere);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
