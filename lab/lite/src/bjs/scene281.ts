// Babylon.js reference for scene 281: the same serialized NPE noise graph and deterministic steps as Lite.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Scene } from "@babylonjs/core/scene";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { NodeParticleSystemSet } from "@babylonjs/core/Particles/Node/nodeParticleSystemSet";
import { ParticleTextureSourceBlock } from "@babylonjs/core/Particles/Node/Blocks/particleSourceTextureBlock";
import "@babylonjs/core/Particles/Node/Blocks";
import "@babylonjs/core/Shaders/particles.vertex";
import "@babylonjs/core/Shaders/particles.fragment";
import { createScene281NpeJson } from "../shared/scene281-npe.js";

const STEPS = 240;

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const camera = new ArcRotateCamera("cam", -Math.PI / 2, 1.2, 9, new Vector3(0, 1, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    const set = NodeParticleSystemSet.Parse(createScene281NpeJson());
    const noiseData = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < 64; i++) {
        const value = Math.floor(((((Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1) + 1) % 1) * 256);
        noiseData[i * 4] = value;
        noiseData[i * 4 + 1] = value;
        noiseData[i * 4 + 2] = value;
        noiseData[i * 4 + 3] = 255;
    }
    const noiseTexture = RawTexture.CreateRGBATexture(noiseData, 8, 8, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    const readableNoiseTexture = noiseTexture as unknown as {
        clone: () => RawTexture;
        getContent: () => Promise<Uint8ClampedArray>;
    };
    readableNoiseTexture.clone = () => noiseTexture;
    readableNoiseTexture.getContent = () => Promise.resolve(noiseData);
    const noiseTextureBlock = set.attachedBlocks.find((block) => block.name === "Noise Texture") as ParticleTextureSourceBlock;
    noiseTextureBlock.sourceTexture = noiseTexture;
    noiseTextureBlock.extractTextureContentAsync = async () => ({ width: 8, height: 8, data: noiseData });
    const built = await set.buildAsync(scene);
    const system = built.systems[0] as ParticleSystem;
    system.particleTexture = new Texture("https://playground.babylonjs.com/textures/flare.png", scene);
    system.preWarmStepOffset = 1;

    let seed = 1;
    Math.random = () => {
        const value = Math.sin(seed++) * 10000;
        return value - Math.floor(value);
    };
    system.start();
    for (let i = 0; i < STEPS; i++) {
        system.animate(true);
    }
    system.updateSpeed = 0;

    const engineWithDrawCalls = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame?: () => void } };
    scene.onBeforeRenderObservable.add(() => {
        engineWithDrawCalls._drawCalls?.fetchNewFrame?.();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(engineWithDrawCalls._drawCalls?.current ?? 0);
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
