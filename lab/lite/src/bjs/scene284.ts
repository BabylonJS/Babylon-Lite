// Babylon.js reference for scene 284: NPE MultiplyAdd blend mode over a colored destination.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { NodeParticleSystemSet } from "@babylonjs/core/Particles/Node/nodeParticleSystemSet";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Particles/Node/Blocks";
import "@babylonjs/core/Shaders/particles.vertex";
import "@babylonjs/core/Shaders/particles.fragment";
import {
    buildScene284TexturePixels,
    createScene284NpeJson,
    SCENE284_CAMERA_RADIUS,
    SCENE284_CLEAR_COLOR,
    SCENE284_STEPS,
    SCENE284_TEXTURE_SIZE,
} from "../shared/scene284-npe-multiply-add-blend.js";

(async function () {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = function () {};

    const scene = new Scene(engine);
    scene.clearColor = new Color4(...SCENE284_CLEAR_COLOR);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2, SCENE284_CAMERA_RADIUS, Vector3.Zero(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    const set = NodeParticleSystemSet.Parse(createScene284NpeJson());
    const built = await set.buildAsync(scene);
    const system = built.systems[0] as ParticleSystem;
    system.particleTexture = RawTexture.CreateRGBATexture(
        buildScene284TexturePixels(),
        SCENE284_TEXTURE_SIZE,
        SCENE284_TEXTURE_SIZE,
        scene,
        false,
        false,
        Texture.NEAREST_SAMPLINGMODE
    );

    let seed = 1;
    Math.random = () => {
        const value = Math.sin(seed++) * 10000;
        return value - Math.floor(value);
    };
    system.start();
    for (let step = 0; step < SCENE284_STEPS; step++) {
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
    canvas.dataset.animationFrozen = "true";
    canvas.dataset.ready = "true";
})().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
