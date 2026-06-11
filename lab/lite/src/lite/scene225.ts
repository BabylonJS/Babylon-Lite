// Scene 225 — Multi-Canvas (same scene structure on two canvases).
//
// Demonstrates `createSurface` by attaching a second `SurfaceContext` to the
// engine and rendering the same scene contents (a colored cube + ground +
// hemispheric light) to both canvases with different camera angles. GPU
// resources (device, pipelines, materials) are shared across the surfaces —
// only the swapchain contexts and per-canvas cameras differ.

import {
    addToScene,
    startEngine,
    createEngine,
    createSurface,
    createSceneContext,
    createArcRotateCamera,
    createHemisphericLight,
    createBox,
    createGround,
    createStandardMaterial,
    attachControl,
    registerScene,
} from "babylon-lite";
import type { ArcRotateCamera, SceneContext, SurfaceContext } from "babylon-lite";

function buildContent(scene: SceneContext, surface: SurfaceContext): void {
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    const ground = createGround(surface.engine, { width: 6, height: 6 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.4, 0.45, 0.5];
    ground.material = groundMat;
    addToScene(scene, ground);

    const box = createBox(surface.engine, 1.2);
    box.position.set(0, 0.8, 0);
    const boxMat = createStandardMaterial();
    boxMat.diffuseColor = [0.85, 0.35, 0.25];
    box.material = boxMat;
    addToScene(scene, box);
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvasA = document.getElementById("canvasA") as HTMLCanvasElement;
    const canvasB = document.getElementById("canvasB") as HTMLCanvasElement;

    // Engine + primary surface (canvas A).
    const engine = await createEngine(canvasA);

    // Auxiliary surface (canvas B) — shares device + GPU resources with the
    // engine; only the swapchain context is per-canvas.
    const surfaceB = createSurface(engine, canvasB);

    // Two scenes — one per surface — with the same content but different cameras.
    const sceneA = createSceneContext(engine);
    sceneA.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.5, 6, { x: 0, y: 0.6, z: 0 });
    attachControl(sceneA.camera as ArcRotateCamera, canvasA, sceneA);
    buildContent(sceneA, engine);

    const sceneB = createSceneContext(surfaceB);
    // Near-top-down to make it visually obvious the two canvases are independent.
    sceneB.camera = createArcRotateCamera(-Math.PI / 2, 0.2, 8, { x: 0, y: 0.6, z: 0 });
    attachControl(sceneB.camera as ArcRotateCamera, canvasB, sceneB);
    buildContent(sceneB, surfaceB);

    await registerScene(engine, sceneA);
    await registerScene(engine, sceneB);
    await startEngine(engine);

    canvasA.dataset.drawCalls = String(engine.drawCallCount);
    canvasA.dataset.initMs = String(performance.now() - __initStart);
    canvasA.dataset.ready = "true";
    canvasB.dataset.ready = "true";
}

main().catch(console.error);
