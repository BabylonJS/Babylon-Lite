import { Animation } from "@babylonjs/core/Animations/animation";
import "@babylonjs/core/Animations/animatable";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

const MANUAL_FRAME_RATE = 12;
const MANUAL_END_FRAME = 4 * MANUAL_FRAME_RATE;

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.14, 0.14, 0.14, 1.0);

    const result = await SceneLoader.ImportMeshAsync("", "https://models.babylonjs.com/", "shark.glb", scene);
    for (const group of scene.animationGroups) {
        if (group.name !== "swimming") {
            group.stop();
        } else {
            group.play(true);
        }
    }

    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const mesh of result.meshes) {
        mesh.refreshBoundingInfo({});
        const bounds = mesh.getBoundingInfo().boundingBox;
        min = Vector3.Minimize(min, bounds.minimumWorld);
        max = Vector3.Maximize(max, bounds.maximumWorld);
    }
    const center = Vector3.Center(min, max);
    const radius = max.subtract(min).length() * 1.5;
    const camera = new ArcRotateCamera("cam", -0.7, Math.PI / 2.2, radius, center, scene);
    camera.minZ = radius * 0.01;
    camera.maxZ = radius * 1000;

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);

    const cameraOrbit = new Animation("cameraOrbit", "alpha", MANUAL_FRAME_RATE, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
    cameraOrbit.setKeys([
        { frame: 0, value: -0.7 },
        { frame: 2 * MANUAL_FRAME_RATE, value: 0.7 },
        { frame: MANUAL_END_FRAME, value: -0.7 },
    ]);
    const cameraAnimatable = scene.beginDirectAnimation(camera, [cameraOrbit], 0, MANUAL_END_FRAME, true);

    engine.getDeltaTime = function () {
        return 16;
    };
    scene.useConstantAnimationDeltaTime = true;

    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "");
    if (Number.isFinite(seekTime)) {
        const seekFrame = seekTime * 60;
        scene.animationGroups.forEach((group) => {
            if (group.name === "swimming") {
                group.goToFrame(seekFrame);
            }
        });
        cameraAnimatable.goToFrame(seekTime * MANUAL_FRAME_RATE);
        scene.animatables.forEach((animatable) => animatable.pause());
        cameraAnimatable.pause();
        canvas.dataset.animationFrozen = "true";
    }

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
        canvas.dataset.cameraAlpha = camera.alpha.toFixed(4);
        const swimming = scene.animationGroups.find((group) => group.name === "swimming");
        if (swimming) {
            canvas.dataset.swimFrame = swimming.animatables[0]?.masterFrame.toFixed(4) ?? "0";
        }
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
