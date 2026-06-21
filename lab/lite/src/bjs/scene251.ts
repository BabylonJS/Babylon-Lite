import { AnimationGroupMask, AnimationGroupMaskMode } from "@babylonjs/core/Animations/animationGroupMask";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import "@babylonjs/loaders/glTF";

const LOWER_BODY_BONES = [
    "mixamorig:LeftUpLeg",
    "mixamorig:LeftLeg",
    "mixamorig:LeftFoot",
    "mixamorig:LeftToeBase",
    "mixamorig:LeftToe_End",
    "mixamorig:RightUpLeg",
    "mixamorig:RightLeg",
    "mixamorig:RightFoot",
    "mixamorig:RightToeBase",
    "mixamorig:RightToe_End",
];

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

    const walk = requireGroup(scene.animationGroups, "walk");
    for (const group of scene.animationGroups) {
        group.stop();
    }

    // Exclude mode → everything animates except the listed lower-body bones, so the
    // hips/spine/arms walk while the legs hold their bind pose.
    walk.mask = new AnimationGroupMask(LOWER_BODY_BONES, AnimationGroupMaskMode.Exclude);
    walk.play(true);
    // Strip the masked-out (lower-body) targeted animations so goToFrame poses only the
    // retained bones; the legs, never animated, hold their bind pose.
    walk.removeUnmaskedAnimations();

    engine.getDeltaTime = function () {
        return 16;
    };
    scene.useConstantAnimationDeltaTime = true;

    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "0.5");
    const seekFrame = seekTime * 60;

    walk.pause();
    const applyFrozenPose = () => {
        walk.goToFrame(seekFrame);
    };
    scene.onBeforeAnimationsObservable.add(applyFrozenPose);
    applyFrozenPose();
    canvas.dataset.animationFrozen = "true";

    const eng = engine as unknown as { _drawCalls?: { fetchNewFrame(): void; current: number } };
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
