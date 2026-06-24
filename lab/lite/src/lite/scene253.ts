// Scene 253 — AnimateAllTheThings (cx20 gltf-test parity).
// Top-down view of the full grid of animated test objects. Exercises
// KHR_lights_punctual, KHR_texture_transform, KHR_materials_unlit/ior/transmission/
// iridescence/volume/emissive_strength and KHR_animation_pointer, plus skinning + morph.
import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    loadEnvironment,
    loadGltf,
    attachControl,
    registerScene,
    onBeforeRender,
    goToFrame,
    pauseAnimation,
    getFrameGraph,
    type RenderTask,
} from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    // Transmissive materials (Volume/Transmission/IOR/Iridescence) need the scene-texture copy.
    (getFrameGraph(scene)._tasks[0] as RenderTask)._config.transmission = { copyCount: 1 };

    const root = await loadGltf(engine, "https://cx20.github.io/gltf-test/tutorialModels/AnimateAllTheThings/glTF/AnimateAllTheThings.gltf");
    addToScene(scene, root);

    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };
    await loadEnvironment(scene, "https://assets.babylonjs.com/environments/environmentSpecular.env", { skipSkybox: true, skipGround: true, brdfUrl: "/brdf-lut.png" });

    // Top-down camera framing the whole grid (world AABB center ~ (0.38, 0.75, -2.53)).
    const cam = createArcRotateCamera(Math.PI / 2, 0.02, 16, { x: 0.38, y: 0.4, z: -2.53 });
    cam.fov = 0.8;
    cam.nearPlane = 0.1;
    cam.farPlane = 100;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    scene.fixedDeltaMs = 16.0;
    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frameCount = 0;
    let seekDone = false;
    onBeforeRender(scene, () => {
        frameCount++;
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
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
