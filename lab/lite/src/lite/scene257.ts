// Scene 257: glTF Node_NegativeScale_01 — two copies of a textured shape, one
// with an identity transform and one with a mirror matrix (diag(-1,1,1) +
// translate) that has a NEGATIVE determinant.
//
// This is Category D of the glTF-Asset-Generator parity sweep: a negative-scale
// node reverses triangle winding relative to the RH->LH root flip, so Lite's
// back-face culling culled the wrong faces (mirrored copy rendered inside-out).
// The loader now reverses the winding for positive-determinant world matrices.
// Static scene; uses the generator's manifest camera.

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, loadGltf, loadEnvironment, attachControl, registerScene } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

const MODEL_URL = "/gltf-assets/Node_NegativeScale/Node_NegativeScale_01.gltf";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    // Generator manifest camera: translation [0, 20, -20], look at origin.
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 4, Math.sqrt(800), { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 1000;
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
