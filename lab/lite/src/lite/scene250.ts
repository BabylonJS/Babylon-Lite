// Scene 250 — VirtualCity (cx20 gltf-test parity)
//
// Exercises the glTF `camera` node property (the `_camera` loader feature):
// cx20's compat matrix (https://github.com/cx20/gltf-test) flags Babylon Lite with
// ":warning: embedded camera" for this model because, before that feature, loadGltf
// silently dropped all 14 of VirtualCity's embedded glTF cameras. This scene selects
// the imported camera named `camera6` — glTF camera index 6, attached to node 116,
// itself a child of an animated flying-vehicle node — so parity actually renders
// through an imported camera and would fail without the feature.
//
// The animation is frozen via `?seekTime=` (seek to seekTime*60 frames) for a
// deterministic golden, matching every other animated cx20 parity scene.
import { onBeforeRender, addToScene, startEngine, createEngine, createSceneContext, loadEnvironment, loadGltf, enableGltfCameras, attachFreeControl, goToFrame, pauseAnimation, registerScene } from "babylon-lite";
import type { FreeCamera } from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    enableGltfCameras();
    const root = await loadGltf(engine, "https://cx20.github.io/gltf-test/sampleModels/VirtualCity/glTF/VirtualCity.gltf");
    addToScene(scene, root);

    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };
    await loadEnvironment(scene, "https://assets.babylonjs.com/environments/environmentSpecular.env", { skipSkybox: true, skipGround: true, brdfUrl: "/brdf-lut.png" });

    const cam = root.cameras!.find((camera) => camera.name === "camera6") as FreeCamera;
    scene.camera = cam;
    attachFreeControl(cam, canvas, scene);

    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frameCount = 0;
    let seekDone = false;
    onBeforeRender(scene, () => {
        frameCount++;
        canvas.dataset.frameCount = String(frameCount);
        if (!isNaN(seekTimeParam) && seekTimeParam > 0 && frameCount === 10 && !seekDone) {
            const seekFrame = seekTimeParam * 60;
            for (const g of scene.animationGroups) {
                goToFrame(g, seekFrame);
            }
            for (const g of scene.animationGroups) {
                pauseAnimation(g);
            }
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
