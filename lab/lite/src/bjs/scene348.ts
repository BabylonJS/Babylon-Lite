// Babylon.js reference for scene 348: the Diligent Kitchen lit by the environment only, with
// SSAO2RenderingPipeline. SSAO2 draws its sampling hemisphere and noise texture from Math.random,
// so pipeline creation runs under a fixed-seed generator to keep the captured golden reproducible.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SSAO2RenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline";
import "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";
import { KITCHEN_ASSET_URL } from "../shared/kitchen-asset.js";

const FROZEN_FRAME = 128;

function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = () => {};
    const scene = new Scene(engine);
    // SSAO2 combines the clear color with zero background visibility, so both scenes clear to black.
    scene.clearColor = new Color4(0, 0, 0, 1);
    const camera = new ArcRotateCamera("camera", 1.8, 1.4, 1.5, new Vector3(0, 1.3, 0), scene);
    camera.minZ = 0.05;
    camera.maxZ = 20;
    camera.attachControl(canvas, true);

    // Original vertex colors on a white, rough, non-metallic base.
    const { meshes } = await ImportMeshAsync(KITCHEN_ASSET_URL, scene);
    const material = new PBRMaterial("kitchen", scene);
    material.albedoColor = Color3.White();
    material.metallic = 0;
    material.roughness = 0.9;
    for (const mesh of meshes) {
        if (mesh.getTotalVertices() > 0) {
            mesh.material = material;
        }
    }

    // Mirror Lite's loadEnvironment image processing (GUIDANCE §1d).
    scene.environmentTexture = CubeTexture.CreateFromPrefilteredData("/textures/environment.env", scene);
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_STANDARD;
    scene.imageProcessingConfiguration.exposure = 0.8;
    scene.imageProcessingConfiguration.contrast = 1.2;

    const random = Math.random;
    Math.random = seededRandom(321);
    try {
        const ssao = new SSAO2RenderingPipeline("ssao", scene, { ssaoRatio: 1, blurRatio: 1 }, [camera]);
        ssao.radius = 0.25;
        ssao.totalStrength = 1.5;
        ssao.samples = 16;
    } finally {
        Math.random = random;
    }

    await scene.whenReadyAsync();
    const interactive = new URLSearchParams(window.location.search).has("interactive");
    let frames = 0;
    engine.runRenderLoop(() => {
        scene.render();
        if (++frames === FROZEN_FRAME && !interactive) {
            engine.stopRenderLoop();
            canvas.dataset.initMs = String(performance.now() - initStart);
            canvas.dataset.ready = "true";
        }
    });
    window.addEventListener("resize", () => engine.resize());
    if (interactive) {
        canvas.dataset.ready = "true";
    }
}

main().catch((error) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error);
    }
});
