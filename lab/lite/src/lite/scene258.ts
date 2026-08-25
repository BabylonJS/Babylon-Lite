// Scene 258: glTF Buffer_Interleaved_03 — a textured plane whose POSITION,
// COLOR_0 and TEXCOORD_0 attributes are interleaved in a single bufferView
// (byteStride 28), with TEXCOORD_0 stored as a normalized UNSIGNED_BYTE accessor
// (componentType 5121). Sibling _04 uses normalized UNSIGNED_SHORT (5123).
//
// This is Category E of the glTF-Asset-Generator parity sweep: Lite bound the
// integer UVs raw to the float32x2 vertex layout (interleaved path) / cast them
// raw to float (tight path), garbling the UVs and mis-mapping the texture. The
// loader now denormalizes non-float TEXCOORD_0/_1 to a tight float32x2 [0,1]
// buffer on both paths. Static scene; generator manifest camera.

import { addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, loadGltf, loadEnvironment, attachControl, registerScene } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

const MODEL_URL = "/gltf-assets/Buffer_Interleaved/Buffer_Interleaved_03.gltf";

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
