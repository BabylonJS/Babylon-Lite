import {
    addAnimationGroups,
    addToScene,
    attachControl,
    createAnimationManager,
    createDefaultCamera,
    createEngine,
    createHemisphericLight,
    createPropertyAnimationClip,
    createPropertyAnimationGroup,
    createSceneContext,
    goToFrame,
    loadGltf,
    onBeforeRender,
    registerScene,
    startEngine,
    stopAnimation,
    updateAnimationManager,
} from "babylon-lite";

const MANUAL_FRAME_RATE = 12;
const MANUAL_END_FRAME = 4 * MANUAL_FRAME_RATE;
const SHARK_URL = "https://models.babylonjs.com/shark.glb";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.14, g: 0.14, b: 0.14, a: 1.0 };
    scene.fixedDeltaMs = 16.0;

    const shark = await loadGltf(engine, SHARK_URL);
    for (const entity of shark.entities) {
        addToScene(scene, entity);
    }
    for (const group of shark.animationGroups ?? []) {
        if (group.name !== "swimming") {
            stopAnimation(group);
        }
    }

    const cam = createDefaultCamera(scene);
    cam.alpha = -0.7;
    cam.beta = Math.PI / 2.2;
    attachControl(cam, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    const manager = createAnimationManager({ engine });
    addAnimationGroups(manager, shark.animationGroups ?? []);
    const cameraClip = createPropertyAnimationClip(
        "cameraOrbit",
        [
            {
                path: "alpha",
                keys: [
                    { frame: 0, value: -0.7 },
                    { frame: 2 * MANUAL_FRAME_RATE, value: 0.7 },
                    { frame: MANUAL_END_FRAME, value: -0.7 },
                ],
            },
        ],
        { frameRate: MANUAL_FRAME_RATE }
    );
    const cameraGroup = createPropertyAnimationGroup(manager, cam, cameraClip, { fromFrame: 0, toFrame: MANUAL_END_FRAME, loop: true });

    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "");
    if (Number.isFinite(seekTime)) {
        const seekFrame = seekTime * 60;
        for (const group of shark.animationGroups ?? []) {
            if (group.name === "swimming") {
                goToFrame(group, seekFrame, engine);
            }
        }
        goToFrame(cameraGroup, seekTime * MANUAL_FRAME_RATE);
        canvas.dataset.animationFrozen = "true";
    } else {
        onBeforeRender(scene, (deltaMs) => updateAnimationManager(manager, deltaMs));
    }

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
