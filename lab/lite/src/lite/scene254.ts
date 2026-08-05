// Scene 254: glTF Animation_SamplerType_01 — a rotation animation whose sampler
// OUTPUT quaternions are stored as a normalized signed BYTE accessor
// (componentType 5120). Sibling model _02 uses normalized signed SHORT (5122).
//
// This is Category A of the glTF-Asset-Generator parity sweep: the loader used
// to throw "Unsupported component type: 5120 / 5122" on these signed accessor
// types. The cube rotates ±90° about Y over t=0..4s; the scene freezes at
// seekTime=2.0 (frame 120 = key 2 = -90° about Y) for deterministic parity.

import {
    onBeforeRender,
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createHemisphericLight,
    loadGltf,
    loadEnvironment,
    attachControl,
    goToFrame,
    registerScene,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

const MODEL_URL = "/gltf-assets/Animation_SamplerType/Animation_SamplerType_01.gltf";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    scene.camera = createArcRotateCamera(Math.PI / 4, Math.PI / 3, 1.6, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 0.01;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });

    addToScene(scene, await loadGltf(engine, MODEL_URL));

    // Fixed timestep for deterministic animation (matches BJS useConstantAnimationDeltaTime)
    scene.fixedDeltaMs = 16.0;

    // Freeze animation for parity tests (triggered by ?seekTime query param)
    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frameCount = 0;
    let seekDone = false;
    onBeforeRender(scene, () => {
        frameCount++;
        if (!isNaN(seekTimeParam) && seekTimeParam > 0 && frameCount === 10 && !seekDone) {
            const seekFrame = seekTimeParam * 60;
            for (const g of scene.animationGroups) {
                goToFrame(g, seekFrame);
            }
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
