// Babylon.js reference for Scene 304. It parses the same Scene-262-derived graph as Lite, including
// scalar/vector Teleport fan-out and the final particle-flow Teleport route.

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
import { createScene304NpeGraph } from "../shared/scene304-npe-teleport.js";

/** Deterministic steps before freezing - must match the Lite scene. */
const STEPS = 200;

(async function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const camera = new ArcRotateCamera("cam", -Math.PI / 2, 1.2, 4, new Vector3(0, 0.3, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;

    // Build the same NPE graph Lite parses.
    const set = NodeParticleSystemSet.Parse(createScene304NpeGraph());
    const built = await set.buildAsync(scene);
    const system = built.systems[0] as ParticleSystem;

    // Use the same resolved flare texture as Lite (the graph stores a relative path).
    system.particleTexture = new Texture("https://playground.babylonjs.com/textures/flare.png", scene);
    system.preWarmStepOffset = 1;

    // Seed Math.random identically to the Lite scene, then step the simulation deterministically and
    // freeze it (updateSpeed 0) so the render loop renders a stable frame.
    let seed = 1;
    Math.random = () => {
        const value = Math.sin(seed++) * 10000;
        return value - Math.floor(value);
    };
    system.start();
    for (let step = 0; step < STEPS; step++) {
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
