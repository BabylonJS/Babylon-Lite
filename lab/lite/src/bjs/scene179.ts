// Scene 179 — Clustered Sponza Lights — Babylon.js reference.
// Mirrors https://playground.babylonjs.com/#CSCJO2#89 with deterministic light
// generation so golden capture and Lite render use the same point-light field.

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import "@babylonjs/core/Lights/Clustered/clusteredLightingSceneComponent";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Loading/loadingScreen";
import "@babylonjs/loaders/glTF";

const MODEL_ROOT = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/Sponza/glTF/";
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

    const lights: PointLight[] = [];
    const rnd = seededRandom(0x5eed177);
    for (let i = 0; i < 1000; i++) {
        const light = new PointLight(`light${i}`, new Vector3(rnd() * 20 - 10, rnd() * 10, rnd() * 10 - 5), scene, true);
        light.diffuse = new Color3(rnd(), rnd(), rnd());
        light.range = 1;
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
