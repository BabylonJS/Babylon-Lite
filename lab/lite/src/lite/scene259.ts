// Scene 259: glTF Material_03 — a flat plane whose PBR material has a dark base
// (baseColorFactor 0.2, metallic 0) but a full-white emissiveFactor [1,1,1] and
// NO emissive texture.
//
// This is Category F of the glTF-Asset-Generator parity sweep: Lite treated an
// emissiveFactor of [1,1,1] as a no-op (it is, but only when an emissive texture
// is present to multiply), so with no texture the emissive was dropped and the
// surface rendered dark. The loader now applies emissiveFactor when there is no
// emissive texture. Static scene; generator manifest camera.

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, loadGltf, loadEnvironment, attachControl, registerScene } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

const MODEL_URL = "/gltf-assets/Material/Material_03.gltf";

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
