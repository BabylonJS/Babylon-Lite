// Scene 65: NME + ESM shadow — sphere casts onto a ground plane, material is an
// NME graph (shared with scene 63). Shadow integration is driven entirely by
// `parseNodeMaterialFromSnippet({ shadowGenerators: [sg] })` — the graph JSON
// itself is identical to scene 63.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createSphere,
    createGround,
    createDirectionalLight,
    createShadowGenerator,
    attachControl,
    registerScene,
    parseNodeMaterialFromSnippet,
} from "babylon-lite";
import { SCENE65_NME_JSON } from "../shared/scene65-nme.js";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    scene.camera = createArcRotateCamera(-Math.PI / 2.3, Math.PI / 2.5, 8, { x: 0, y: 1, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 1000;
    attachControl(scene.camera, canvas, scene);

    const light = createDirectionalLight([-1, -2, -1], 1);
    light.position.set(5, 10, 5);
    addToScene(scene, light);

    const sphere = createSphere(engine);
    sphere.position.set(0, 1.5, 0);

    const ground = createGround(engine, { width: 10, height: 10, subdivisions: 2 });
    ground.receiveShadows = true;

    light.shadowGenerator = createShadowGenerator(engine, light, [sphere], {
        mapSize: 1024,
        depthScale: 50,
        bias: 0.00005,
        blurKernel: 64,
        blurScale: 2,
        darkness: 0,
        frustumEdgeFalloff: 0,
        orthoMinZ: scene.camera.nearPlane,
        orthoMaxZ: scene.camera.farPlane,
    });

    const material = await parseNodeMaterialFromSnippet(engine, "", {
        json: SCENE65_NME_JSON,
        shadowGenerators: [light.shadowGenerator],
    });
    (sphere as { material?: unknown }).material = material;
    (ground as { material?: unknown }).material = material;
    addToScene(scene, sphere);
    addToScene(scene, ground);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
