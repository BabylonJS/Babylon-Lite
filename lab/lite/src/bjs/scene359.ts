// Babylon.js reference for Scene 359. It parses the same values/math NPE graph as Lite, seeds the RNG
// identically, steps the simulation a fixed number of times, and renders the frozen frame.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Scene } from "@babylonjs/core/scene";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { NodeParticleSystemSet } from "@babylonjs/core/Particles/Node/nodeParticleSystemSet";
import "@babylonjs/core/Particles/Node/Blocks";
import "@babylonjs/core/Shaders/particles.vertex";
import "@babylonjs/core/Shaders/particles.fragment";
import { SCENE359_NPE_JSON, SCENE359_STEPS } from "../shared/scene359-values-math-npe.js";

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const camera = new ArcRotateCamera("cam", -Math.PI / 2, 1.25, 7, new Vector3(0, 2, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    const set = NodeParticleSystemSet.Parse(SCENE359_NPE_JSON);
    const built = await set.buildAsync(scene);
    const system = built.systems[0] as ParticleSystem;

    // Use the same resolved sprite sheet as Lite (the graph stores a relative path).
    system.particleTexture = new Texture("https://playground.babylonjs.com/textures/player.png", scene, false, false);
    system.preWarmStepOffset = 1;

    // Seed Math.random identically to the Lite scene, then step the simulation deterministically and
    // freeze it (updateSpeed 0) so the render loop renders a stable frame.
    let seed = 1;
    Math.random = () => {
        const value = Math.sin(seed++) * 10000;
        return value - Math.floor(value);
    };
    system.start();
    for (let step = 0; step < SCENE359_STEPS; step++) {
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
})().catch((error) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error);
    }
});
