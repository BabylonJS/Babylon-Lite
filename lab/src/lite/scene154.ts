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
    goToFrame,
    registerScene,
    startAnimationManager,
    startEngine,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

const FRAME_RATE = 10;
const END_TIME = 2;

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

    const linearBox = createBox(engine);
    linearBox.material = createStandardMaterial();
    linearBox.position.x = -1.5;
    linearBox.position.y = 0.8;
    addToScene(scene, linearBox);

    const stepBox = createBox(engine);
    stepBox.material = createStandardMaterial();
    stepBox.position.x = -1.5;
    stepBox.position.y = -0.8;
    addToScene(scene, stepBox);

    const manager = createAnimationManager();
    const linearClip = createPropertyAnimationClip(
        "linearTimeSlide",
        [
            {
                path: "position.x",
                keys: [
                    { time: 0, value: -1.5 },
                    { time: 1, value: 1.5 },
                    { time: END_TIME, value: -1.5 },
                ],
            },
        ],
        { frameRate: FRAME_RATE }
    );
    const stepClip = createPropertyAnimationClip(
        "stepTimeSlide",
        [
            {
                path: "position.x",
                interpolation: "step",
                keys: [
                    { time: 0, value: -1.5 },
                    { time: 1, value: 1.5 },
                    { time: END_TIME, value: -1.5 },
                ],
            },
        ],
        { frameRate: FRAME_RATE }
    );
    const linearGroup = createPropertyAnimationGroup(manager, linearBox, linearClip, { fromTime: 0, toTime: END_TIME, loop: true });
    const stepGroup = createPropertyAnimationGroup(manager, stepBox, stepClip, { fromTime: 0, toTime: END_TIME, loop: true });

    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "");
    if (Number.isFinite(seekTime)) {
        goToFrame(linearGroup, seekTime * FRAME_RATE);
        goToFrame(stepGroup, seekTime * FRAME_RATE);
        canvas.dataset.animationFrozen = "true";
    } else {
        startAnimationManager(manager);
    }

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
