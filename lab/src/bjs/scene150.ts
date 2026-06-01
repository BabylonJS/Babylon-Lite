import { Animation } from "@babylonjs/core/Animations/animation";
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
    box.position.x = 2;

    const xSlide = new Animation("xSlide", "position.x", FRAME_RATE, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
    xSlide.setKeys([
        { frame: 0, value: 2 },
        { frame: FRAME_RATE, value: -2 },
        { frame: END_FRAME, value: 2 },
    ]);
    const animatable = scene.beginDirectAnimation(box, [xSlide], 0, END_FRAME, true);

    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "");
    if (Number.isFinite(seekTime)) {
        animatable.goToFrame(seekTime * FRAME_RATE);
        animatable.pause();
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
