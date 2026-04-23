// Scene 64: NME morph targets — sphere translated +Y via a MorphTargetsBlock.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createSphere,
    createSphereData,
    createMorphTargets,
    attachControl,
    registerScene,
    parseNodeMaterialFromSnippet,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";
import { SCENE64_NME_JSON, SCENE64_MORPH_DELTA_Y } from "../shared/scene64-nme.js";

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

    const material = await parseNodeMaterialFromSnippet(engine, "", { json: SCENE64_NME_JSON });

    const sphereData = createSphereData();
    const vertexCount = sphereData.vertexCount;
    const deltas = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
        deltas[i * 3 + 1] = SCENE64_MORPH_DELTA_Y;
    }
    const sphere = createSphere(engine) as Mesh & { morphTargets?: unknown };
    sphere.morphTargets = createMorphTargets(engine, [{ positions: deltas, normals: null }], vertexCount, [1.0]);
    (sphere as { material?: unknown }).material = material;
    addToScene(scene, sphere);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
