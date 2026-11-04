import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Helpers/sceneHelpers";
import "@babylonjs/core/Loading/loadingScreen";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    // Parity harness screenshots the canvas; suppress the loading overlay so the
    // spinner can't be captured and inflate MAD (mirrors the other BJS ref scenes).
    engine.displayLoadingUI = function () {};

    const scene = new Scene(engine);

    await SceneLoader.AppendAsync(
        "https://cx20.github.io/gltf-test/tutorialModels/AnimatedWaterfall/glTF/",
        "AnimatedWaterfall.gltf",
        scene,
    );

    // Light the scene purely from the shared IBL environment. The model's two
    // KHR_lights_punctual spot lights are animated (day/night) via the same
    // KHR_animation_pointer clip; Babylon Lite bakes punctual lights at load
    // and cannot reproduce that, so both engines drop them to keep the parity
    // test focused on the mesh animation (grass rotation + water UV scroll).
    scene.lights.slice().forEach((l) => l.dispose());

    scene.createDefaultEnvironment({ createGround: false, createSkybox: false });

    const camera = new ArcRotateCamera("camera", Math.PI / 2, Math.PI / 2, 21, new Vector3(0.15, 1.6, 0.25), scene);
    camera.fov = 0.8;
    camera.attachControl(canvas, true);
    scene.activeCamera = camera;

    engine.getDeltaTime = function () {
        return 16;
    };
    scene.useConstantAnimationDeltaTime = true;

    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");

    let frameCount = 0;
    let seekDone = false;
    scene.onBeforeRenderObservable.add(() => {
        frameCount++;
        canvas.dataset.frameCount = String(frameCount);

        if (!isNaN(seekTimeParam) && frameCount === 10 && !seekDone) {
            scene.animationGroups.forEach((g) => {
                const range = g.to - g.from;
                const frame = range > 0 ? g.from + ((seekTimeParam * 60 - g.from) % range) : g.from;
                g.goToFrame(frame);
            });
            scene.animatables.forEach((a) => a.pause());
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
        }
    });

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    const cam = scene.activeCamera as ArcRotateCamera;
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camBeta = String(cam.beta);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.camTarget = `${cam.target.x},${cam.target.y},${cam.target.z}`;
    canvas.dataset.camFov = String(cam.fov);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
