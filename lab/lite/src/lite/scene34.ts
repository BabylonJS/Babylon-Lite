// Scene 34 — KHR_node_visibility + KHR_animation_pointer — matches PG #YG3BBF#55
// Loads CubeVisibility.glb: three cubes, one always visible (green), one
// blinking via animation-pointer targeting its visibility flag (blue), and
// two hidden via KHR_node_visibility (red). Default IBL environment, no
// skybox, no ground. Deterministic capture uses ?seekTime=0 and pauses
// all animation groups after the first tick so parity tests can diff
// against a stable golden.

import { onBeforeRender, addToScene, startEngine, createEngine, createSceneContext, createDefaultCamera, loadEnvironment, loadGltf, attachControl, goToFrame, pauseAnimation, registerScene } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const root = await loadGltf(engine, "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/CubeVisibility/glTF-Binary/CubeVisibility.glb");

    addToScene(scene, root);

    await loadEnvironment(scene, "https://assets.babylonjs.com/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });

    const cam = createDefaultCamera(scene);
    cam.alpha += Math.PI;
    attachControl(cam, canvas, scene);

    // Fixed timestep so seek-to-frame yields an identical interpolated pose
    // as the BJS reference (matches Babylon's useConstantAnimationDeltaTime=16).
    scene.fixedDeltaMs = 16.0;

    // Parity hooks: ?seekTime=N → seek every animation group to frame N*60
    // and pause. Skips until frame 10 so that the load/IBL prefiltering/first
    // renders settle, matching the BJS reference's cadence.
    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frameCount = 0;
    let seekDone = false;

    onBeforeRender(scene, () => {
        frameCount++;
        canvas.dataset.frameCount = String(frameCount);

        if (!isNaN(seekTimeParam) && frameCount === 10 && !seekDone) {
            const seekFrame = seekTimeParam * 60;
            for (const g of scene.animationGroups) {
                goToFrame(g, seekFrame);
                pauseAnimation(g);
            }
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
    (window as any).__scene = scene;
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camBeta = String(cam.beta);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.camTarget = `${cam.target.x},${cam.target.y},${cam.target.z}`;
    canvas.dataset.camFov = String(cam.fov);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
