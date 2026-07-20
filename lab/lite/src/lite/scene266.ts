// Scene 266 — Gaussian Splatting glTF (Lite).
// Ports playground #WSAFDA#0: loads Halo_Believe.glb, whose single POINTS-mode
// primitive carries the KHR_gaussian_splatting extension, via loadGltf(). The new
// gltf-feature-gaussian-splatting.ts converts the glTF attributes into Lite's
// standard splat row buffer and attaches a GaussianSplattingMesh to the scene.
// Waits for the first worker sort before flagging the canvas ready.

import { addToScene, attachControl, createArcRotateCamera, createEngine, createSceneContext, loadGltf, registerScene, startEngine } from "babylon-lite";

const GLB_URL = "https://assets.babylonjs.com/splats/gltf/Halo_Believe.glb";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    // Orbit (ArcRotate) camera framing the splat at the origin; drag to orbit in the lab.
    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.5, 6, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const container = await loadGltf(engine, GLB_URL);
    addToScene(scene, container);

    await registerScene(scene);
    await startEngine(engine);

    // The KHR_gaussian_splatting feature exposes one promise per GS primitive via
    // the container's `_gaussianSplats`; each resolves to the attached GaussianSplattingMesh.
    const splats = container._gaussianSplats ?? [];
    const splat = await splats[0]!;
    // Wait for the worker's first back-to-front sort so the screenshot is settled.
    await splat.firstSortReady;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
