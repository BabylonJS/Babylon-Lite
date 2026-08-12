// Scene 281: Node Particle Editor - Noise Texture.

import {
    addFacingBillboardSystem,
    animateParticleSystem,
    attachControl,
    buildNodeParticleSetWithNoiseTextures,
    createArcRotateCamera,
    createEngine,
    createParticleBillboard,
    createSceneContext,
    parseNodeParticleSource,
    registerNodeParticleSet,
    registerScene,
    startEngine,
    startParticleSystem,
    syncParticleBillboard,
} from "babylon-lite";
import { createScene281NpeJson } from "../shared/scene281-npe.js";

const STEPS = 240;

async function main(): Promise<void> {
    const initStart = performance.now();
    const params = new URLSearchParams(window.location.search);
    const live = params.has("live");
    const noise = params.get("noise") !== "off";
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, 1.2, 9, { x: 0, y: 1, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const graph = parseNodeParticleSource(
        createScene281NpeJson({
            noise,
            noiseStrength: live ? [6, 2, 6] : undefined,
            deterministicEmitter: live,
        })
    );
    const set = await buildNodeParticleSetWithNoiseTextures(engine, scene, graph, {
        emitter: { x: 0, y: 0, z: 0 },
        textureBaseUrl: "https://playground.babylonjs.com/",
    });
    const system = set.systems[0]!;

    let seed = 1;
    Math.random = () => {
        const value = Math.sin(seed++) * 10000;
        return value - Math.floor(value);
    };
    if (live) {
        registerNodeParticleSet(scene, set);
    } else {
        startParticleSystem(system);
        for (let i = 0; i < STEPS; i++) {
            animateParticleSystem(system, 1);
        }

        const billboard = createParticleBillboard(system);
        syncParticleBillboard(system, billboard);
        addFacingBillboardSystem(scene, billboard);
    }

    await registerScene(scene);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    if (!live) {
        canvas.dataset.animationFrozen = "true";
    }
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err instanceof Error ? err.message : err);
    }
});
