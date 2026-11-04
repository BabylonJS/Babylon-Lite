// Scene 252: StandardMaterial morph target — a sphere deformed into a teardrop
// by a single position morph target, validating morph support on StandardMaterial.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createDirectionalLight,
    createSphere,
    createSphereData,
    createStandardMaterial,
    createMorphTargets,
    attachControl,
    registerScene,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";
import { SCENE252_MORPH_WEIGHT, scene252MorphDeltas } from "../shared/scene252-stdmorph.js";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(-Math.PI / 2, 1.15, 4, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 10000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    const light = createDirectionalLight([0, -1, 0]);
    light.diffuse = [1, 0, 0];
    light.specular = [0, 1, 0];
    addToScene(scene, light);

    const sphereOptions = { segments: 32, diameter: 1 };
    const sphere = createSphere(engine, sphereOptions);
    sphere.material = createStandardMaterial();

    const data = createSphereData(sphereOptions);
    const deltas = scene252MorphDeltas(data.positions);
    sphere.morphTargets = createMorphTargets(engine, [{ positions: deltas, normals: null }], data.vertexCount, [SCENE252_MORPH_WEIGHT]);

    addToScene(scene, sphere);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
