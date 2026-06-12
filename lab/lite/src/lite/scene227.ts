// Scene 227 — Multi-Canvas (same scene contents shared across two surfaces).
//
// Demonstrates `createSurface` by attaching a second `SurfaceContext` to the
// engine and rendering a *single* set of meshes + materials + lights through
// both canvases with different camera angles.
//
// What this actually proves about the architecture:
//   - Mesh GPU buffers (`mesh._gpu`) are device-scoped — adding the same
//     `Mesh` to two `SceneContext`s creates two renderables that share the
//     vertex/index buffers.
//   - Materials own pipelines + bind-group layouts, which are also
//     device-scoped — the same `StandardMaterial` instance drives both
//     scenes' renderables.
//   - `LightBase` data is plain JS (no GPU resources) and can sit in both
//     scenes' light lists.
//   - Each scene/surface still owns its own per-scene UBO, framegraph, and
//     camera, so the two canvases present the same content from independent
//     viewpoints.

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
import type { ArcRotateCamera } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const renderCanvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const canvasB = document.getElementById("canvasB") as HTMLCanvasElement;

    // Engine + primary surface (canvas A).
    const engine = await createEngine(renderCanvas);

    // Auxiliary surface (canvas B) — shares device + GPU resources with the
    // engine; only the swapchain context is per-canvas.
    const surfaceB = createSurface(engine, canvasB);

    // ── Build shared scene contents ONCE — these are device-scoped (mesh GPU
    //    buffers, material pipelines) or plain data (lights), so both scenes
    //    can reference the same instances. ───────────────────────────────────
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.4, 0.45, 0.5];

    const ground = createGround(engine, { width: 6, height: 6 });
    ground.material = groundMat;

    const boxMat = createStandardMaterial();
    boxMat.diffuseColor = [0.85, 0.35, 0.25];

    const box = createBox(engine, 1.2);
    box.position.set(0, 0.8, 0);
    box.material = boxMat;

    const light = createHemisphericLight([0, 1, 0], 1.0);

    // ── Two scenes — one per surface — both populated from the shared
    //    entities above, but each with its own camera. ────────────────────────
    const sceneA = createSceneContext(engine);
    sceneA.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.5, 6, { x: 0, y: 0.6, z: 0 });
    attachControl(sceneA.camera as ArcRotateCamera, renderCanvas, sceneA);
    addToScene(sceneA, light);
    addToScene(sceneA, ground);
    addToScene(sceneA, box);

    const sceneB = createSceneContext(surfaceB);
    // Orbit camera offset 3/4 around the box (different alpha + tilt) so the
    // two canvases obviously show the same content from independent viewpoints.
    sceneB.camera = createArcRotateCamera(-Math.PI / 4, Math.PI / 3.5, 6, { x: 0, y: 0.6, z: 0 });
    attachControl(sceneB.camera as ArcRotateCamera, canvasB, sceneB);
    addToScene(sceneB, light);
    addToScene(sceneB, ground);
    addToScene(sceneB, box);

    await registerScene(sceneA);
    await registerScene(sceneB);
    await startEngine(engine);

    renderCanvas.dataset.drawCalls = String(engine.drawCallCount);
    renderCanvas.dataset.initMs = String(performance.now() - __initStart);
    renderCanvas.dataset.ready = "true";
    canvasB.dataset.ready = "true";
}

main().catch(console.error);
