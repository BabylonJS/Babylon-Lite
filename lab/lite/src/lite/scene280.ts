// Scene 280: Node Particle Editor - Update Flow Map.

import {
    addFacingBillboardSystem,
    animateParticleSystem,
    attachControl,
    buildNodeParticleSetWithFlowMaps,
    createArcRotateCamera,
    createEngine,
    createParticleBillboard,
    createSceneContext,
    parseNodeParticleSource,
    registerScene,
    startEngine,
    startParticleSystem,
    syncParticleBillboard,
} from "babylon-lite";
import { createScene280NpeJson } from "../shared/scene280-npe.js";

const STEPS = 300;

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 9, { x: -5, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const graph = parseNodeParticleSource(createScene280NpeJson());
    const set = await buildNodeParticleSetWithFlowMaps(engine, scene, graph, {
        emitter: { x: 0, y: 0, z: 0 },
        textureBaseUrl: "https://playground.babylonjs.com/",
    });
    const system = set.systems[0]!;

    let seed = 1;
    Math.random = () => {
        const x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    };

    startParticleSystem(system);
    for (let i = 0; i < STEPS; i++) {
        animateParticleSystem(system, 1);
    }

    const billboard = createParticleBillboard(system);
    syncParticleBillboard(system, billboard);
    addFacingBillboardSystem(scene, billboard);

    await registerScene(scene);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.animationFrozen = "true";
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err instanceof Error ? err.message : err);
    }
});
