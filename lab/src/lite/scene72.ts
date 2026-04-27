// Scene 72: Final D8AK3Z PBR-NME parity. Fetches EPY8BV/6 (the full
// PBR-MR + Reflection + ClearCoat + Sheen + Anisotropy + SubSurface NME
// graph) and renders the 4-light scene from playground D8AK3Z#160.
//
// NOTE: scene 72 currently runs with skipParity:true because anisotropy
// and subsurface are marker-only in the Lite emitter. The scene loads,
// parses the snippet, and renders to validate parser/registry coverage
// of all PBR blocks together. Real anisotropy/subsurface math is future
// work after the agent is freed for a focused pass on those layers.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createSphere,
    createGround,
    createHemisphericLight,
    createPointLight,
    createSpotLight,
    createDirectionalLight,
    createPcfDirectionalShadowGenerator,
    attachControl,
    registerScene,
    parseNodeMaterialFromSnippet,
    loadEnvironment,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";
import { fetchScene72Snippet } from "../shared/scene72.js";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.6, g: 0.8, b: 1, a: 1 };

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 7, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 1000;
    attachControl(scene.camera, canvas, scene);

    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });

    const hemi = createHemisphericLight([0, 1, 0], 1);
    addToScene(scene, hemi);
    const point = createPointLight([0, 5, -2], 1);
    addToScene(scene, point);
    const spot = createSpotLight([-0.5, 0, -2], [0, 0, 1], Math.PI / 2, 1, 1);
    addToScene(scene, spot);
    const dir = createDirectionalLight([1, -1, 1], 10);
    addToScene(scene, dir);

    const sphere = createSphere(engine, { segments: 32, diameter: 2 });
    const ground = createGround(engine, { width: 6, height: 6, subdivisions: 2 });
    ground.position.set(0, -1, 0);
    ground.receiveShadows = true;
    (ground as Mesh & { layerMask?: number }).layerMask = 1;

    const sg = createPcfDirectionalShadowGenerator(engine, dir, [sphere], { mapSize: 1024, orthoMinZ: -2, orthoMaxZ: 15 });
    dir.shadowGenerator = sg;

    const { json } = await fetchScene72Snippet();
    const material = await parseNodeMaterialFromSnippet(engine, "", { json, shadowGenerators: [sg] });
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

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
