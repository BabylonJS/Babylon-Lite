// Scene 167 — PBR Lightmap — Babylon.js reference.
// Mirrors the Lite scene: levelTest.glb keeps its glTF PBR materials and gets the baked
// lightmap on UV2 as a shadowmap (multiply, level 3.2, uAng = π), and two procedural PBR
// boxes get the same texture additively on UV1 at level 0.8.

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Loading/loadingScreen";
import "@babylonjs/loaders/glTF";

const LEVEL_BASE = "https://cdn.jsdelivr.net/gh/CedricGuillemet/dump@master/CharController/";

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
    const camera = new FreeCamera("camera", new Vector3(3, 5, -16), scene);
    camera.setTarget(new Vector3(3, 0, -6));
    scene.activeCamera = camera;

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    const lightmap = new Texture(LEVEL_BASE + "lightmap.jpg", scene);
    lightmap.uAng = Math.PI;
    lightmap.level = 3.2;
    lightmap.coordinatesIndex = 1;

    await SceneLoader.AppendAsync(LEVEL_BASE, "levelTest.glb", scene);
    // Only the `level` meshes carry TEXCOORD_1 (the `Cube*` props do not), so the UV2 lightmap
    // goes on their materials alone — same split as scene104.
    for (const mesh of scene.meshes) {
        if (mesh.name !== "level" && !mesh.name.startsWith("level_primitive")) {
            continue;
        }
        const material = mesh.material;
        if (material instanceof PBRMaterial) {
            material.lightmapTexture = lightmap;
            material.useLightmapAsShadowmap = true;
        }
    }

    // Additive lightmap on UV1 (procedural boxes carry no TEXCOORD_1).
    const boxLightmap = new Texture(LEVEL_BASE + "lightmap.jpg", scene);
    boxLightmap.uAng = Math.PI;
    boxLightmap.level = 0.8;
    boxLightmap.coordinatesIndex = 0;

    const boxMaterial = new PBRMaterial("boxMat", scene);
    boxMaterial.albedoColor = new Color3(0.32, 0.32, 0.34);
    boxMaterial.metallic = 0.0;
    boxMaterial.roughness = 0.55;
    boxMaterial.lightmapTexture = boxLightmap;
    for (const x of [0.5, 5.5]) {
        const box = CreateBox("box", { size: 2 }, scene);
        box.position.set(x, 1, -12);
        box.material = boxMaterial;
    }

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
