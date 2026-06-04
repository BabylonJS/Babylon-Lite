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
    onBeforeRender,
    registerScene,
    parseNodeMaterialFromSnippet,
    setMorphTargetWeights,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";
import { SCENE64_NME_JSON, SCENE64_MORPH_DELTA_Y, SCENE64_MORPH_PERIOD_MS } from "../shared/scene64-nme.js";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 10000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    const material = await parseNodeMaterialFromSnippet(engine, "", { json: SCENE64_NME_JSON });

    const sphereData = createSphereData();
    const vertexCount = sphereData.vertexCount;
    const deltas = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
        deltas[i * 3 + 1] = SCENE64_MORPH_DELTA_Y;
    }
    const sphere = createSphere(engine) as Mesh & { morphTargets?: unknown };
    const freeze = new URLSearchParams(location.search).has("freeze");
    const morph = createMorphTargets(engine, [{ positions: deltas, normals: null }], vertexCount, [freeze ? 1.0 : 0]);
    sphere.morphTargets = morph;
    (sphere as { material?: unknown }).material = material;
    addToScene(scene, sphere);

    // Animate the morph weight with a cosine loop so the sphere visibly
    // pulses between base and morphed shape. Parity tests append ?freeze=1
    // to pin the weight at 1.0 for a deterministic capture.
    if (!freeze) {
        const t0 = performance.now();
        const weightBuf = new Float32Array([0]);
        onBeforeRender(scene, () => {
            const t = (performance.now() - t0) / SCENE64_MORPH_PERIOD_MS;
            weightBuf[0] = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
            setMorphTargetWeights(engine, morph, weightBuf);
        });
    }

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
