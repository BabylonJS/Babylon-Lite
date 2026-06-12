import { onBeforeRender, addToScene, startEngine, createEngine, createSceneContext, createDefaultCamera, loadEnvironment, loadGltf, createHemisphericLight, attachControl, goToFrame, pauseAnimation, registerScene } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    addToScene(scene, await loadGltf(engine, "https://www.babylonjs.com/Assets/ChibiRex/glTF/ChibiRex_Saturated.gltf"));
    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        groundTextureUrl: "https://assets.babylonjs.com/core/environments/backgroundGround.png",
        brdfUrl: "/brdf-lut.png",
    });

    const cam = createDefaultCamera(scene);
    // Match Babylon.js createDefaultCameraOrLight framing exactly
    cam.alpha = -4.401261725665929;
    cam.beta = Math.PI / 2;
    cam.radius = 8.17809474926393;
    cam.target = { x: -0.025979936122894287, y: 1.6681787837296724, z: 0.4591848850250244 };
    cam.nearPlane = 0.08178094749263931;
    cam.farPlane = 8178.094749263931;
    attachControl(cam, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    // Fixed timestep matching Babylon.js useConstantAnimationDeltaTime (16.0ms)
    scene.fixedDeltaMs = 16.0;

    // Freeze at frame 300 only for parity tests (triggered by ?freeze query param)
    const params = new URLSearchParams(window.location.search);
    const shouldFreeze = params.has("freeze");
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frameCount = 0;
    let seekDone = false;
    onBeforeRender(scene, () => {
        frameCount++;
        canvas.dataset.frameCount = String(frameCount);

        // Seek mode: after init frames, seek to exact frame and pause
        if (!isNaN(seekTimeParam) && seekTimeParam > 0 && frameCount === 10 && !seekDone) {
            const seekFrame = seekTimeParam * 60;
            for (const g of scene.animationGroups) {
                goToFrame(g, seekFrame);
            }
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
        }

        // Frame-count freeze mode
        if (shouldFreeze && !seekDone && frameCount === 300) {
            for (const g of scene.animationGroups) {
                pauseAnimation(g);
            }
            canvas.dataset.animationFrozen = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
    (window as any).__scene = scene;
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
