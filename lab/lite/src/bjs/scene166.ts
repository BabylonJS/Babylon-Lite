// Scene 166 — Clustered Sponza Spot Lights — Babylon.js reference.
// Mirrors scene 179's Sponza setup with clustered SPOT lights, so the golden capture
// and the Lite render use the same deterministic light field.

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import "@babylonjs/core/Lights/Clustered/clusteredLightingSceneComponent";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Loading/loadingScreen";
import "@babylonjs/loaders/glTF";

const MODEL_ROOT = "https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Models@master/2.0/Sponza/glTF/";
const MODEL_FILE = "Sponza.gltf";

function seededRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (1664525 * s + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

function waitForLoadingScreenHidden(): Promise<void> {
    return new Promise((resolve) => {
        const check = () => {
            const loadingDiv = document.getElementById("babylonjsLoadingDiv");
            if (!loadingDiv || getComputedStyle(loadingDiv).display === "none" || loadingDiv.style.opacity === "0") {
                resolve();
                return;
            }
            requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
    });
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    const camera = new FreeCamera("camera", new Vector3(-5, 2, 0), scene);
    camera.setTarget(new Vector3(0, 3, 0));
    camera.speed = 0.2;
    camera.attachControl(canvas, true);
    scene.activeCamera = camera;

    await SceneLoader.AppendAsync(MODEL_ROOT, MODEL_FILE, scene);
    for (const material of scene.materials) {
        if (material instanceof PBRMaterial) {
            material.useGLTFLightFalloff = true;
        }
    }

    const lights: SpotLight[] = [];
    const rnd = seededRandom(0x5eed166);
    for (let i = 0; i < 1000; i++) {
        // Draw order must match the Lite scene exactly: position, colour, direction, angle.
        const position = new Vector3(rnd() * 20 - 10, rnd() * 10, rnd() * 10 - 5);
        const diffuse = new Color3(rnd(), rnd(), rnd());
        const direction = new Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
        const angle = (rnd() * 0.4 + 0.35) * Math.PI;
        const light = new SpotLight(`light${i}`, position, direction, angle, 0, scene, true);
        light.diffuse = diffuse;
        light.range = 2;
        light.intensity = 2;
        lights.push(light);
    }
    new ClusteredLightContainer("clusteredLights", lights, scene);

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame(): void; current: number } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    engine.hideLoadingUI();
    await waitForLoadingScreenHidden();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
