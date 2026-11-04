import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

const HIDDEN_BONE = "mixamorig:LeftArm";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1.0);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2.4, 4, new Vector3(0, 1, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 1000;
    camera.attachControl(canvas, true);

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene).intensity = 0.6;
    new DirectionalLight("dir", new Vector3(0, -0.5, -1), scene).intensity = 0.8;

    await SceneLoader.ImportMeshAsync("", "https://playground.babylonjs.com/scenes/", "Xbot.glb", scene);

    // Static bind pose: stop the glTF loader's auto-played clip and return to rest.
    for (const group of scene.animationGroups) {
        group.stop();
    }
    const skeleton = scene.skeletons[0];
    if (skeleton) {
        skeleton.returnToRest();

        // Hide the whole left arm by collapsing its bone local matrix: zero the 3x3
        // (rotation+scale) while keeping the bind-pose translation. This is exactly what
        // Babylon Lite's setBoneVisible(false) produces (local scale → 0), so the same
        // sub-tree degenerates to a point in both engines.
        const bone = skeleton.bones.find((candidate) => candidate.name === HIDDEN_BONE);
        if (bone) {
            const t = bone.getLocalMatrix().getTranslation();
            const collapsed = Matrix.FromValues(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, t.x, t.y, t.z, 1);
            bone.updateMatrix(collapsed);
        }
        skeleton.prepare();
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
