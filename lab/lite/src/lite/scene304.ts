// Scene 304: Node Particle Editor Teleport graph plumbing.
//
// Uses Scene 262's deterministic particle oracle with Teleports plus Elbow, Debug, and a Particle
// LocalVariable. Graph normalization must preserve the exact frozen rendered state.

import {
    addFacingBillboardSystem,
    animateParticleSystem,
    buildNodeParticleSet,
    createArcRotateCamera,
    createEngine,
    createParticleBillboard,
    createSceneContext,
    normalizeNodeParticleGraph,
    parseNodeParticleSource,
    registerScene,
    startEngine,
    startParticleSystem,
    syncParticleBillboard,
} from "babylon-lite";
import { createScene304NpeGraph } from "../shared/scene304-teleport-npe.js";

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
    // This frozen parity fixture mirrors the non-interactive Babylon.js oracle, so controls are intentionally omitted.

    const graph = await normalizeNodeParticleGraph(parseNodeParticleSource(createScene304NpeGraph()));
    const set = await buildNodeParticleSet(engine, scene, graph, {
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
    for (let step = 0; step < STEPS; step++) {
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

main().catch((error) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(error instanceof Error ? error.message : error);
    }
});
