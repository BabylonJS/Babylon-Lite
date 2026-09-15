import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    getContainerMeshes,
    loadUsd,
    registerScene,
    startEngine,
} from "babylon-lite";
import { createUsdPerformanceStage } from "../shared/usd-performance-stage.js";

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.04, g: 0.05, b: 0.08, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 115, { x: 0, y: 0, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    addToScene(scene, createHemisphericLight([0.2, 1, 0.3], 1));

    const loadStart = performance.now();
    const container = await loadUsd(engine, createUsdPerformanceStage());
    const loadMs = performance.now() - loadStart;
    addToScene(scene, container);
    const meshes = getContainerMeshes(container);

    await registerScene(scene);
    await startEngine(engine);

    canvas.dataset.sourceMeshes = String(meshes.length);
    canvas.dataset.thinInstances = String(meshes.reduce((count, mesh) => count + (mesh.thinInstances?.count ?? 0), 0));
    canvas.dataset.triangles = String(meshes.reduce((count, mesh) => count + (mesh._cpuIndices?.length ?? 0) / 3, 0));
    canvas.dataset.loadMs = String(loadMs);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

void main().catch((error) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    canvas.dataset.error = error instanceof Error ? error.message : String(error);
    console.error(error);
});
