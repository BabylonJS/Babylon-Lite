// Scene 228 — Multi-Canvas (different scenes on two canvases).
//
// Demonstrates `createSurface` by attaching a second `SurfaceContext` to the
// engine and rendering two entirely different scenes — a row of standard-shaded
// spheres on canvas A, and a single textured torus knot lit by a directional
// light on canvas B. Both share the same `GPUDevice` and engine-owned GPU
// resources; each has its own swapchain context, scene graph, lights, and
// camera controls.

import {
    addToScene,
    startEngine,
    createEngine,
    createSurface,
    createSceneContext,
    createArcRotateCamera,
    createHemisphericLight,
    createDirectionalLight,
    createSphere,
    createTorusKnot,
    createStandardMaterial,
    attachControl,
    registerScene,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const renderCanvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const canvasB = document.getElementById("canvasB") as HTMLCanvasElement;

    // Engine + primary surface (canvas A).
    const engine = await createEngine(renderCanvas);

    // Auxiliary surface (canvas B) — shares the engine's GPU device.
    const surfaceB = createSurface(engine, canvasB);

    // ── Scene A — row of colored spheres + hemispheric light ──────────────
    const sceneA = createSceneContext(engine);
    sceneA.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.2, 9, { x: 0, y: 0, z: 0 });
    attachControl(sceneA.camera as ArcRotateCamera, renderCanvas, sceneA);
    sceneA.clearColor = { r: 0.12, g: 0.13, b: 0.18, a: 1.0 };
    addToScene(sceneA, createHemisphericLight([0, 1, 0], 1.0));

    const colors: [number, number, number][] = [
        [0.85, 0.35, 0.25],
        [0.3, 0.8, 0.45],
        [0.3, 0.55, 0.95],
        [0.95, 0.8, 0.3],
        [0.75, 0.4, 0.85],
    ];
    for (let i = 0; i < colors.length; i++) {
        const sphere = createSphere(engine, { diameter: 1.2, segments: 16 });
        sphere.position.set((i - (colors.length - 1) / 2) * 1.6, 0, 0);
        const mat = createStandardMaterial();
        mat.diffuseColor = colors[i]!;
        sphere.material = mat;
        addToScene(sceneA, sphere);
    }

    // ── Scene B — single torus knot lit by a directional light ────────────
    const sceneB = createSceneContext(surfaceB);
    sceneB.camera = createArcRotateCamera(Math.PI / 4, Math.PI / 3, 6, { x: 0, y: 0, z: 0 });
    attachControl(sceneB.camera as ArcRotateCamera, canvasB, sceneB);
    sceneB.clearColor = { r: 0.2, g: 0.15, b: 0.12, a: 1.0 };

    const dir = createDirectionalLight([-0.4, -1, 0.3]);
    dir.diffuse = [1, 0.9, 0.75];
    addToScene(sceneB, dir);
    addToScene(sceneB, createHemisphericLight([0, 1, 0], 0.25));

    const knot = createTorusKnot(surfaceB.engine, { radius: 1.4, tube: 0.35, radialSegments: 96, tubularSegments: 16 });
    const knotMat = createStandardMaterial();
    knotMat.diffuseColor = [0.85, 0.55, 0.25];
    knotMat.specularColor = [0.9, 0.85, 0.7];
    knot.material = knotMat;
    addToScene(sceneB, knot);

    await registerScene(sceneA);
    await registerScene(sceneB);
    await startEngine(engine);

    renderCanvas.dataset.drawCalls = String(engine.drawCallCount);
    renderCanvas.dataset.initMs = String(performance.now() - __initStart);
    renderCanvas.dataset.ready = "true";
    canvasB.dataset.ready = "true";
}

main().catch(console.error);
