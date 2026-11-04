// Scene 39 — KHR_animation_pointer: node-TRS + texture-transform (AnimatedWaterfall)
// Loads AnimatedWaterfall.gltf whose animation drives meshes entirely through
// KHR_animation_pointer: the grass blades rotate via /nodes/{n}/rotation pointers
// and the water/foam surfaces scroll via /materials/{m}/.../KHR_texture_transform
// offset+scale pointers. Default IBL environment, no skybox/ground. Deterministic
// capture uses ?seekTime=N (freezes every animation group at frame N*60).

import { onBeforeRender, addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, loadEnvironment, loadGltf, attachControl, goToFrame, pauseAnimation, registerScene } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const root = await loadGltf(engine, "https://cx20.github.io/gltf-test/tutorialModels/AnimatedWaterfall/glTF/AnimatedWaterfall.gltf");

    addToScene(scene, root);

    // Light purely from the shared IBL environment. The model's two animated
    // KHR_lights_punctual spot lights (day/night, driven by the same pointer
    // clip) are baked at load in Lite and cannot be animated, so both engines
    // drop them — keeping this parity test focused on the mesh animation.
    scene.lights.length = 0;

    await loadEnvironment(scene, "https://assets.babylonjs.com/environments/environmentSpecular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });

    const cam = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 21, { x: 0.15, y: 1.6, z: 0.25 });
    cam.fov = 0.8;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    // Fixed timestep so seek-to-frame yields an identical interpolated pose as
    // the BJS reference (matches Babylon's useConstantAnimationDeltaTime=16).
    scene.fixedDeltaMs = 16.0;

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
