// Scene 260: glTF Mesh_PrimitiveMode_11 — a quad drawn as a TRIANGLE_STRIP
// (primitive mode 5) with uint32 indices.
//
// This is Category C of the glTF-Asset-Generator parity sweep: Lite hardcoded a
// triangle-list pipeline, so non-triangle primitive topologies (POINTS, LINES,
// LINE_STRIP, TRIANGLE_STRIP) were interpreted as triangle lists and rendered
// garbled (an "X" instead of the expected geometry). The loader now reads the
// glTF primitive `mode` and the PBR pipeline honors the matching WebGPU topology
// (with stripIndexFormat for indexed strips). Static scene; generator camera.

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, loadGltf, loadEnvironment, attachControl, registerScene } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

const MODEL_URL = "/gltf-assets/Mesh_PrimitiveMode/Mesh_PrimitiveMode_11.gltf";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    // Generator manifest camera: translation [0, 0, 1.3], look at origin.
    scene.camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 1.3, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 0.01;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });

    addToScene(scene, await loadGltf(engine, MODEL_URL));

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
