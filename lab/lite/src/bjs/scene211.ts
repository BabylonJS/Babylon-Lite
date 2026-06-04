// Scene 211 — Khronos BrainStem (EXT_meshopt_compression) — Babylon.js reference
// glTF meshopt + quantization sample asset (CC0). Skinned + animated.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { MeshoptCompression } from "@babylonjs/core/Meshes/Compression/meshoptCompression";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

// Use the same vendored decoder as Babylon-Lite for deterministic parity.
MeshoptCompression.Configuration = { decoder: { url: "/meshopt_decoder.js" } };

const MODEL_ROOT = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/BrainStem/glTF-Meshopt-EXT/";
const MODEL_FILE = "BrainStem.gltf";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const light = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    light.intensity = 1.0;

    await SceneLoader.ImportMeshAsync("", MODEL_ROOT, MODEL_FILE, scene);

    const cam = new ArcRotateCamera("cam", Math.PI / 2, Math.PI / 2.2, 4.5, new Vector3(-0.045, 0.043, 0.917), scene);
    scene.activeCamera = cam;

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

        if (!isNaN(seekTimeParam) && seekTimeParam > 0 && frameCount === 10 && !seekDone) {
            scene.animationGroups.forEach((g) => {
                const range = g.to - g.from;
                if (range > 0) {
                    const seekFrame = g.from + ((seekTimeParam * 60 - g.from) % range);
                    g.goToFrame(seekFrame);
                }
            });
            scene.animatables.forEach((a) => a.pause());
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
        }

        if (!seekDone && frameCount === 300) {
            scene.animatables.forEach((a) => a.pause());
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
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
