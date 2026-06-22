import {
    addToScene,
    attachControl,
    createAnimationManager,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createEngine,
    createHemisphericLight,
    createPropertyAnimationClip,
    createPropertyAnimationGroup,
    createSceneContext,
    createStandardMaterial,
    enablePropertyAnimationBlending,
    pauseAnimation,
    registerScene,
    setAnimationWeight,
    startAnimationManager,
    startEngine,
    updateAnimationManager,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

const FRAME_RATE = 10;
const END_FRAME = 2 * FRAME_RATE;
const POSITIVE_WEIGHT = 0.25;
const NEGATIVE_WEIGHT = 0.75;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 4, 10, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 10000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    addToScene(scene, createDirectionalLight([0, -1, 1], 0.75));
    addToScene(scene, createHemisphericLight([0, 1, 0], 0.5));

    const box = createBox(engine);
    box.material = createStandardMaterial();
    addToScene(scene, box);

    const manager = createAnimationManager();
    const positiveSlide = createPropertyAnimationClip(
        "weightedPositive",
        [
            {
                path: "position.x",
                keys: [
                    { frame: 0, value: 0 },
                    { frame: FRAME_RATE, value: 2 },
                    { frame: END_FRAME, value: 0 },
                ],
            },
        ],
        { frameRate: FRAME_RATE }
    );
    const negativeSlide = createPropertyAnimationClip(
        "weightedNegative",
        [
            {
                path: "position.x",
                keys: [
                    { frame: 0, value: 0 },
                    { frame: FRAME_RATE, value: -2 },
                    { frame: END_FRAME, value: 0 },
                ],
            },
        ],
        { frameRate: FRAME_RATE }
    );

    const positiveGroup = createPropertyAnimationGroup(manager, box, positiveSlide, { fromFrame: 0, toFrame: END_FRAME, loop: true });
    const negativeGroup = createPropertyAnimationGroup(manager, box, negativeSlide, { fromFrame: 0, toFrame: END_FRAME, loop: true });
    enablePropertyAnimationBlending(manager);
    setAnimationWeight(positiveGroup, POSITIVE_WEIGHT);
    setAnimationWeight(negativeGroup, NEGATIVE_WEIGHT);

    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "");
    if (Number.isFinite(seekTime)) {
        positiveGroup.currentTime = seekTime;
        negativeGroup.currentTime = seekTime;
        pauseAnimation(positiveGroup);
        pauseAnimation(negativeGroup);
        updateAnimationManager(manager, 0);
        canvas.dataset.boxX = String(box.position.x);
        canvas.dataset.animationFrozen = "true";
    } else {
        startAnimationManager(manager);
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.boxX = String(box.position.x);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
