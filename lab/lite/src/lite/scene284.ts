// Scene 284: Node Particle Editor - MultiplyAdd blend mode.

import {
    animateParticleSystem,
    buildNodeParticleSet,
    createArcRotateCamera,
    createEngine,
    createSceneContext,
    createTexture2DFromPixels,
    enableNodeParticleBlendModes,
    parseNodeParticleSource,
    registerNodeParticleSet,
    registerScene,
    startEngine,
    startParticleSystem,
} from "babylon-lite";
import {
    buildScene284TexturePixels,
    createScene284NpeJson,
    SCENE284_CAMERA_RADIUS,
    SCENE284_CLEAR_COLOR,
    SCENE284_STEPS,
    SCENE284_TEXTURE_SIZE,
} from "../shared/scene284-npe-multiply-add-blend.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: SCENE284_CLEAR_COLOR[0], g: SCENE284_CLEAR_COLOR[1], b: SCENE284_CLEAR_COLOR[2], a: SCENE284_CLEAR_COLOR[3] };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, SCENE284_CAMERA_RADIUS, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;

    const graph = parseNodeParticleSource(createScene284NpeJson());
    const set = enableNodeParticleBlendModes(
        await buildNodeParticleSet(engine, scene, graph, {
            emitter: { x: 0, y: 0, z: 0 },
            textureBaseUrl: "https://playground.babylonjs.com/",
        })
    );
    const system = set.systems[0]!;
    system.texture = createTexture2DFromPixels(engine, buildScene284TexturePixels(), SCENE284_TEXTURE_SIZE, SCENE284_TEXTURE_SIZE, {
        minFilter: "nearest",
        magFilter: "nearest",
    });

    let seed = 1;
    Math.random = () => {
        const value = Math.sin(seed++) * 10000;
        return value - Math.floor(value);
    };
    startParticleSystem(system);
    for (let step = 0; step < SCENE284_STEPS; step++) {
        animateParticleSystem(system, 1);
    }
    system.updateSpeed = 0;
    registerNodeParticleSet(scene, set, { autoStart: false });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.animationFrozen = "true";
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
