// Scene 283: Node Particle Editor - Multiply blend mode.

import {
    addFacingBillboardSystemWithParticleBlend,
    animateParticleSystem,
    buildNodeParticleSetWithBlendModes,
    createArcRotateCamera,
    createEngine,
    createParticleBillboard,
    createSceneContext,
    createTexture2DFromPixels,
    parseNodeParticleSource,
    registerNodeParticleSet,
    registerScene,
    startEngine,
    startParticleSystem,
    syncParticleBillboard,
} from "babylon-lite";
import {
    buildScene283TexturePixels,
    createScene283NpeJson,
    SCENE283_CLEAR_COLOR,
    SCENE283_STEPS,
    SCENE283_TEXTURE_SIZE,
} from "../shared/scene283-npe-multiply-blend.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const live = new URLSearchParams(window.location.search).has("live");
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: SCENE283_CLEAR_COLOR[0], g: SCENE283_CLEAR_COLOR[1], b: SCENE283_CLEAR_COLOR[2], a: SCENE283_CLEAR_COLOR[3] };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 4, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;

    const graph = parseNodeParticleSource(createScene283NpeJson({ live }));
    const set = await buildNodeParticleSetWithBlendModes(engine, scene, graph, {
        emitter: { x: 0, y: 0, z: 0 },
        textureBaseUrl: "https://playground.babylonjs.com/",
    });
    const system = set.systems[0]!;
    system.texture = createTexture2DFromPixels(engine, buildScene283TexturePixels(), SCENE283_TEXTURE_SIZE, SCENE283_TEXTURE_SIZE, {
        minFilter: "nearest",
        magFilter: "nearest",
    });

    let seed = 1;
    Math.random = () => {
        const value = Math.sin(seed++) * 10000;
        return value - Math.floor(value);
    };
    if (live) {
        registerNodeParticleSet(scene, set);
    } else {
        startParticleSystem(system);
        for (let step = 0; step < SCENE283_STEPS; step++) {
            animateParticleSystem(system, 1);
        }

        const billboard = createParticleBillboard(system);
        syncParticleBillboard(system, billboard);
        addFacingBillboardSystemWithParticleBlend(scene, billboard);
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    if (!live) {
        canvas.dataset.animationFrozen = "true";
    }
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
