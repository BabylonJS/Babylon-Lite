// Scene 255: glTF Animation_SkinType_01 — a skinned plane whose vertex WEIGHTS
// are stored as a normalized UNSIGNED_BYTE accessor (componentType 5121). The
// sibling _02 uses normalized UNSIGNED_SHORT (5123).
//
// This is Category B of the glTF-Asset-Generator parity sweep: Lite read the
// normalized integer weights raw (0..255) instead of denormalizing to 0..1,
// which exploded the skin and left the canvas blank. The plane bends via the
// skeleton over t=0..2s; the scene freezes at seekTime=1.0 for deterministic
// parity.

import {
    onBeforeRender,
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    loadGltf,
    loadEnvironment,
    attachControl,
    goToFrame,
    registerScene,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

const MODEL_URL = "/gltf-assets/Animation_SkinType/Animation_SkinType_01.gltf";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    scene.camera = createArcRotateCamera(0.87606, Math.PI / 2, 0.78102, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 0.01;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

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
