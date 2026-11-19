// Babylon.js reference for scene 356 — the classic GlowLayer API, which also runs unchanged through the compat layer.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import type { Material } from "@babylonjs/core/Materials/material";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import "@babylonjs/core/Materials/Node/Blocks";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { GLOW_SCENE } from "../shared/scene356-glow.js";
import { SCENE356_GLOW_NME_JSON, SCENE356_PLAIN_NME_JSON } from "../shared/scene356-nme.js";

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    const scene = new Scene(engine);
    scene.clearColor = new Color4(...GLOW_SCENE.background, 1);
    const camera = new ArcRotateCamera("camera", GLOW_SCENE.alpha, GLOW_SCENE.beta, GLOW_SCENE.radius, new Vector3(...GLOW_SCENE.target), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;
    camera.attachControl(canvas, true);
    const light = new HemisphericLight("light", new Vector3(...GLOW_SCENE.lightDirection), scene);
    light.intensity = GLOW_SCENE.lightIntensity;

    let index = 0;
    const box = (material: Material, position: readonly [number, number, number], size: readonly [number, number, number]): void => {
        const mesh = MeshBuilder.CreateBox(`box${index++}`, { width: size[0], height: size[1], depth: size[2] }, scene);
        mesh.material = material;
        mesh.position.set(...position);
    };

    const matte = new StandardMaterial("matte", scene);
    matte.diffuseColor = new Color3(...GLOW_SCENE.matteDiffuse);
    matte.specularColor = new Color3(...GLOW_SCENE.matteSpecular);
    box(matte, [0, 1.5, 0.9], [8, 3.2, 0.2]);
    box(matte, [0, 0, 0], [8, 0.15, 3]);

    const cyan = new StandardMaterial("cyan", scene);
    cyan.disableLighting = true;
    cyan.emissiveColor = new Color3(0.03, 0.8, 1);
    box(cyan, [-3, 1.5, 0.4], [0.1, 2.5, 0.1]);
    box(matte, [-3, 0.9, -0.1], [1, 1.4, 0.2]);

    const magenta = new PBRMaterial("magenta", scene);
    magenta.albedoColor = Color3.Black();
    magenta.metallic = 0;
    magenta.roughness = 1;
    magenta.emissiveColor = new Color3(1, 0.04, 0.32);
    box(magenta, [-1.7, 1.5, 0.4], [0.1, 2.5, 0.1]);

    const amber = new StandardMaterial("amber", scene);
    amber.disableLighting = true;
    amber.emissiveColor = Color3.White();
    amber.emissiveTexture = RawTexture.CreateRGBATexture(new Uint8Array([255, 89, 6, 255]), 1, 1, scene, false, false);
    box(amber, [-0.3, 2.65, 0.4], [1.6, 0.1, 0.1]);

    const nodeGlow = NodeMaterial.Parse(SCENE356_GLOW_NME_JSON, scene);
    box(nodeGlow, [1.3, 1.25, 0.4], [1.2, 1.2, 0.1]);
    const nodePlain = NodeMaterial.Parse(SCENE356_PLAIN_NME_JSON, scene);
    box(nodePlain, [1.75, 0.8, -0.35], [0.7, 0.7, 0.7]);

    const glow = new GlowLayer("glow", scene, { blurKernelSize: GLOW_SCENE.kernel });
    glow.intensity = GLOW_SCENE.intensity;

    await scene.whenReadyAsync();
    let frames = 0;
    engine.runRenderLoop(() => {
        scene.render();
        if (++frames === GLOW_SCENE.settleFrames) {
            canvas.dataset.initMs = String(performance.now() - initStart);
            canvas.dataset.ready = "true";
        }
    });
    window.addEventListener("resize", () => engine.resize());
})().catch((error: unknown) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error);
    }
});
