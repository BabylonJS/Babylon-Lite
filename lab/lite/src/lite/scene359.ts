// Scene 359: Node Particle Editor values and math.
//
// A sprite-sheet fountain whose position, colour, size, and sprite cell are computed by the NPE value/math block
// family (Trigonometry, NLerp, SmoothStep, Clamp, Step, NumberMath, VectorMath, FloatToInt, Int typing, sprite-cell
// sources, UpdateSpriteCellIndex). Deterministic and frozen to match the Babylon.js oracle.

import {
    addBillboardSystemToScene,
    animateParticleSystem,
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
import { SCENE359_NPE_JSON, SCENE359_STEPS } from "../shared/scene359-values-math-npe.js";

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, 1.25, 7, { x: 0, y: 2, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    // This frozen parity fixture mirrors the non-interactive Babylon.js oracle, so controls are intentionally omitted.

    const set = await buildNodeParticleSet(engine, scene, parseNodeParticleSource(SCENE359_NPE_JSON), {
        emitter: { x: 0, y: 0, z: 0 },
        textureBaseUrl: "https://playground.babylonjs.com/",
    });
    const system = set.systems[0]!;

    // Seed Math.random deterministically (matching the Babylon.js oracle), then step the simulation a
    // fixed number of times for a frozen, reproducible frame.
    let seed = 1;
    Math.random = () => {
        const value = Math.sin(seed++) * 10000;
        return value - Math.floor(value);
    };

    startParticleSystem(system);
    for (let step = 0; step < SCENE359_STEPS; step++) {
        animateParticleSystem(system, 1);
    }
    // Babylon.js keeps animating the frozen system (updateSpeed 0) on every rendered frame, re-running this graph's
    // absolute size/colour/cell updates on the particle spawned by the last step. Mirror one such zero-step frame.
    system.updateSpeed = 0;
    animateParticleSystem(system, 1);

    const billboard = createParticleBillboard(system);
    syncParticleBillboard(system, billboard);
    addBillboardSystemToScene(scene, billboard);

    await registerScene(scene);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.animationFrozen = "true";
    canvas.dataset.ready = "true";
}

main().catch((error) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error instanceof Error ? error.message : error);
    }
});
