// Scene 262: Node Particle Editor — "Basic Properties - Size".
//
// Builds a Node Particle graph (a classic ParticleSystem converted to NPE) and renders its particles as
// camera-facing additive billboards. The simulation is stepped a fixed number of times with the RNG seeded
// deterministically, so the frame is frozen and reproducible for pixel parity against the Babylon.js oracle.

import {
    addFacingBillboardSystem,
    animateParticleSystem,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createParticleBillboard,
    createSceneContext,
    parseNodeParticleSetFromSnippet,
    registerScene,
    startEngine,
    startParticleSystem,
    syncParticleBillboard,
} from "babylon-lite";
import { SCENE262_NPE_JSON } from "../shared/scene262-npe.js";

/** Number of deterministic simulation steps before the frame is frozen. */
const STEPS = 200;

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, 1.2, 4, { x: 0, y: 0.3, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const set = await parseNodeParticleSetFromSnippet(engine, scene, "", {
        json: SCENE262_NPE_JSON,
        emitter: { x: 0, y: 0, z: 0 },
        textureBaseUrl: "https://playground.babylonjs.com/",
    });
    const system = set.systems[0]!;

    // Seed Math.random deterministically (matching the Babylon.js oracle), then step the simulation a
    // fixed number of times for a frozen, reproducible frame.
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
