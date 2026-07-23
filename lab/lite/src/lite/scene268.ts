// Scene 268: Node Particle Editor - Animations 2 (sprite sheet).

import {
    addFacingBillboardSystem,
    animateParticleSystem,
    attachControl,
    buildNodeParticleSet,
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
import { SCENE268_NPE_JSON } from "../shared/scene268-npe.js";

const STEPS = 200;

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, 1.2, 4, { x: -1, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const graph = parseNodeParticleSource(SCENE268_NPE_JSON);
    const set = await buildNodeParticleSet(engine, scene, graph, {
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
