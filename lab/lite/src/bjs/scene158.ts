import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

const POSE_FRAME = 2;

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const camera = new ArcRotateCamera("camera", Math.PI / 2, Math.PI / 4, 3, new Vector3(0, 1, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 1000;
    camera.attachControl(canvas, true);

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene).intensity = 0.6;
    new DirectionalLight("dir", new Vector3(0, -0.5, -1), scene).intensity = 0.8;

    await SceneLoader.ImportMeshAsync("", "https://playground.babylonjs.com/scenes/", "Xbot.glb", scene);

    const idle = requireGroup(scene.animationGroups, "idle");
    const sadPose = AnimationGroup.MakeAnimationAdditive(requireGroup(scene.animationGroups, "sad_pose"));

    for (const group of scene.animationGroups) {
        group.stop();
        group.weight = 0;
    }

    idle.loopAnimation = true;
    idle.play(true);
    idle.weight = 1;
    sadPose.weight = 1;
    sadPose.start(true, 1, POSE_FRAME, POSE_FRAME);

    engine.getDeltaTime = function () {
        return 16;
    };
    scene.useConstantAnimationDeltaTime = true;

    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "");
    if (Number.isFinite(seekTime)) {
        const seekFrame = seekTime * 60;
        idle.pause();
        sadPose.pause();
        const applyFrozenPose = () => {
            idle.goToFrame(seekFrame, true);
            sadPose.goToFrame(POSE_FRAME, true);
        };
        scene.onBeforeAnimationsObservable.add(applyFrozenPose);
        applyFrozenPose();
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
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);

function requireGroup(groups: readonly AnimationGroup[], name: string): AnimationGroup {
    const group = groups.find((candidate) => candidate.name === name);
    if (!group) {
        throw new Error(`Xbot animation group "${name}" was not found`);
    }
    return group;
}
