import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import "@babylonjs/core/Animations/animatable";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import "@babylonjs/core/Materials/standardMaterial";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

const FRAME_RATE = 10;
const END_FRAME = 2 * FRAME_RATE;
const FADE_START_MS = 1000;
const FADE_DURATION_MS = 1000;

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const camera = new ArcRotateCamera("Camera", -Math.PI / 2, Math.PI / 4, 10, Vector3.Zero(), scene);
    camera.minZ = 1;
    camera.maxZ = 10000;
    camera.attachControl(canvas, true);

    const light1 = new DirectionalLight("DirectionalLight", new Vector3(0, -1, 1), scene);
    const light2 = new HemisphericLight("HemiLight", new Vector3(0, 1, 0), scene);
    light1.intensity = 0.75;
    light2.intensity = 0.5;

    const box = MeshBuilder.CreateBox("box", {}, scene);

    const positiveSlide = new Animation("crossFadePositive", "position.x", FRAME_RATE, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
    positiveSlide.setKeys([
        { frame: 0, value: 0 },
        { frame: FRAME_RATE, value: 2 },
        { frame: END_FRAME, value: 0 },
    ]);

    const negativeSlide = new Animation("crossFadeNegative", "position.x", FRAME_RATE, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
    negativeSlide.setKeys([
        { frame: 0, value: 0 },
        { frame: FRAME_RATE, value: -2 },
        { frame: END_FRAME, value: 0 },
    ]);

    const positiveGroup = new AnimationGroup("crossFadePositive", scene);
    positiveGroup.addTargetedAnimation(positiveSlide, box);
    positiveGroup.weight = 1;
    positiveGroup.start(true, 1, 0, END_FRAME);

    const negativeGroup = new AnimationGroup("crossFadeNegative", scene);
    negativeGroup.addTargetedAnimation(negativeSlide, box);
    negativeGroup.weight = 0;
    negativeGroup.start(true, 1, 0, END_FRAME);

    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "");
    if (Number.isFinite(seekTime)) {
        const frame = seekTime * FRAME_RATE;
        const fadeT = Math.min(1, Math.max(0, (seekTime * 1000 - FADE_START_MS) / FADE_DURATION_MS));
        positiveGroup.weight = 1 - fadeT;
        negativeGroup.weight = fadeT;
        positiveGroup.goToFrame(frame, true);
        negativeGroup.goToFrame(frame, true);
        positiveGroup.pause();
        negativeGroup.pause();
        canvas.dataset.animationFrozen = "true";
    } else {
        const startedAt = performance.now();
        scene.onBeforeAnimationsObservable.add(() => {
            const fadeT = Math.min(1, Math.max(0, (performance.now() - startedAt - FADE_START_MS) / FADE_DURATION_MS));
            positiveGroup.weight = 1 - fadeT;
            negativeGroup.weight = fadeT;
        });
    }

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
