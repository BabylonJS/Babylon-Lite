import {
    addAnimationGroups,
    addToScene,
    attachControl,
    createAnimationManager,
    createArcRotateCamera,
    createDirectionalLight,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    enableAnimationBlending,
    loadGltf,
    onBeforeRender,
    pauseAnimation,
    playAnimation,
    registerScene,
    setAnimationWeight,
    startEngine,
    stopAnimation,
    updateAnimationManager,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

const XBOT_URL = "https://playground.babylonjs.com/scenes/Xbot.glb";
const WALK_WEIGHT = 0.5;
const RUN_WEIGHT = 0.5;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };
    scene.fixedDeltaMs = 16.0;

    scene.camera = createArcRotateCamera(Math.PI / 2, Math.PI / 4, 3, { x: 0, y: 1, z: 0 });
    scene.camera.nearPlane = 0.1;
    scene.camera.farPlane = 1000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.6));
    addToScene(scene, createDirectionalLight([0, -0.5, -1], 0.8));

    const xbot = await loadGltf(engine, XBOT_URL);
    for (const entity of xbot.entities) {
        addToScene(scene, entity);
    }

    const manager = createAnimationManager({ engine });
    const walk = xbot.animationGroups?.find((group) => group.name === "walk");
    const run = xbot.animationGroups?.find((group) => group.name === "run");
    if (!walk || !run) {
        throw new Error("Xbot walk/run animation groups were not found");
    }
    for (const group of xbot.animationGroups ?? []) {
        stopAnimation(group);
        setAnimationWeight(group, 0);
    }
    for (const group of [walk, run]) {
        group.loopAnimation = true;
        playAnimation(group);
    }
    addAnimationGroups(manager, [walk, run]);
    setAnimationWeight(walk, WALK_WEIGHT);
    setAnimationWeight(run, RUN_WEIGHT);
    enableAnimationBlending(manager);

    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "");
    if (Number.isFinite(seekTime)) {
        for (const group of [walk, run]) {
            group.currentTime = seekTime;
            pauseAnimation(group);
        }
        canvas.dataset.animationFrozen = "true";
    }
    onBeforeRender(scene, (deltaMs) => updateAnimationManager(manager, deltaMs));

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
