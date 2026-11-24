// Babylon.js reference for scene 357 — ShaderMaterial surfaces in a GlowLayer: without emissive color they render in
// the neutral color, unless the color selector picks them. PBR covers emissive textures and bright unlit non-emitters.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import type { Material } from "@babylonjs/core/Materials/material";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { GLOW_SCENE, SCENE357_BAR_COLOR, SCENE357_LED_COLOR, SCENE357_OCCLUDER_COLOR, scene357BabylonShader } from "../shared/scene356-glow.js";

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
    const box = (material: Material, position: readonly [number, number, number], size: readonly [number, number, number]): Mesh => {
        const mesh = MeshBuilder.CreateBox(`box${index++}`, { width: size[0], height: size[1], depth: size[2] }, scene);
        mesh.material = material;
        mesh.position.set(...position);
        return mesh;
    };
    const shader = (name: string, color: readonly number[]): Material => {
        const source = scene357BabylonShader(color);
        ShaderStore.ShadersStoreWGSL[`scene357${name}VertexShader`] = source.vertex;
        ShaderStore.ShadersStoreWGSL[`scene357${name}FragmentShader`] = source.fragment;
        return new ShaderMaterial(
            name,
            scene,
            { vertex: `scene357${name}`, fragment: `scene357${name}` },
            { attributes: ["position"], uniformBuffers: ["Scene", "Mesh"], shaderLanguage: ShaderLanguage.WGSL }
        );
    };

    const matte = new StandardMaterial("matte", scene);
    matte.diffuseColor = new Color3(...GLOW_SCENE.matteDiffuse);
    matte.specularColor = new Color3(...GLOW_SCENE.matteSpecular);
    box(matte, [0, 1.5, 0.9], [8, 3.2, 0.2]);
    box(matte, [0, 0, 0], [8, 0.15, 3]);

    const led = new StandardMaterial("led", scene);
    led.disableLighting = true;
    led.emissiveColor = new Color3(...SCENE357_LED_COLOR);
    box(led, [-1.5, 1.5, 0.4], [0.1, 2.5, 0.1]);
    box(shader("occluder", SCENE357_OCCLUDER_COLOR), [-1.5, 0.9, -0.3], [0.9, 0.9, 0.9]);
    const bar = box(shader("bar", SCENE357_BAR_COLOR), [1.2, 2.2, 0.4], [2.4, 0.12, 0.1]);
    bar.metadata = { glowColor: [...SCENE357_BAR_COLOR] };

    const amber = new PBRMaterial("amber", scene);
    amber.albedoColor = Color3.Black();
    amber.metallic = 0;
    amber.roughness = 1;
    amber.emissiveTexture = RawTexture.CreateRGBATexture(new Uint8Array([255, 89, 6, 255]), 1, 1, scene, false, false);
    amber.emissiveTexture.gammaSpace = false;
    amber.emissiveColor = Color3.White();
    box(amber, [-3, 1.5, 0.4], [0.1, 2.5, 0.1]);
    const white = new PBRMaterial("white", scene);
    white.unlit = true;
    white.albedoColor = Color3.White();
    box(white, [3.2, 1, 0.1], [0.8, 0.8, 0.8]);

    const glow = new GlowLayer("glow", scene, { blurKernelSize: GLOW_SCENE.kernel });
    glow.intensity = GLOW_SCENE.intensity;
    glow.customEmissiveColorSelector = (mesh, _subMesh, material, result) => {
        const color = (mesh.metadata as { glowColor?: readonly number[] } | null)?.glowColor;
        if (color) {
            result.set(color[0]!, color[1]!, color[2]!, 1);
        } else if (material instanceof StandardMaterial || material instanceof PBRMaterial) {
            // The layer's own default for a material with an emissive color.
            const level = (material.emissiveTexture?.level ?? 1) * ((material as PBRMaterial).emissiveIntensity ?? 1);
            result.set(material.emissiveColor.r * level, material.emissiveColor.g * level, material.emissiveColor.b * level, material.alpha);
        } else {
            result.set(0, 0, 0, 1);
        }
    };

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
