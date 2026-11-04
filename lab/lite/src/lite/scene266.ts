// Scene 266: glTF NegativeScaleTest (Khronos sample) — the double-sided material
// sphere grid. Each row is a material (Not Shiny / Shiny / Dark, all doubleSided)
// rendered twice: an un-mirrored copy and a negative-scale (mirrored) copy that
// has reversed triangle winding relative to the RH->LH root flip.
//
// Regression for the negative-scale shading bug: Lite previously reversed winding
// by flipping the pipeline cull face (cullMode "front") while keeping
// frontFace "ccw". That left WebGPU's @builtin(front_facing) evaluated against the
// un-mirrored winding, so the double-sided shader's front-facing normal flip
// inverted the (already correct) outward normal on the visible surface of every
// mirrored sphere -> N·V < 0 -> the reflective spheres rendered black. The loader
// now reverses winding by flipping frontFace (ccw->cw), matching BJS's
// sideOrientation flip, so front_facing stays consistent with the geometry.
//
// Static scene; golden captured from BJS.

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, loadGltf, loadEnvironment, attachControl, registerScene } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

const MODEL_URL = "/gltf-assets/NegativeScaleTest/NegativeScaleTest.glb";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.15, 10.5, { x: 0.35, y: -1.9, z: 0 });
    scene.camera.nearPlane = 0.1;
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
