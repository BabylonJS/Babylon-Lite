// BJS reference for scene 270 — mirrored StandardMaterial meshes.
// Same four boxes as the Lite scene. Babylon flips `sideOrientation` from the world-matrix
// determinant, so mirrored meshes render right side out natively.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

void (async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();
    engine.displayLoadingUI = function () {};

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.15, 0.16, 0.22, 1.0);

    const camera = new ArcRotateCamera("camera", -Math.PI / 2 + 0.5, Math.PI / 3, 26, Vector3.Zero(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 200;
    camera.attachControl(canvas, true);

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.7;
    const dir = new DirectionalLight("dir", new Vector3(-0.4, -1, 0.6), scene);
    dir.intensity = 0.8;

    const mat = new StandardMaterial("mat", scene);
    mat.diffuseColor = new Color3(0.35, 0.6, 0.9);
    mat.specularColor = Color3.Black();

    const box = (x: number) => {
        const m = CreateBox("box", { size: 4 }, scene);
        m.position.set(x, 0, 0);
        m.material = mat;
        return m;
    };

    // 1. Control — never mirrored.
    box(-9);

    // 2. Mirrored before first render.
    box(-3).scaling.set(-1, 1, 1);

    // 3. Mirrored at runtime.
    const runtimeBox = box(3);

    // 4. Mirrored at runtime through an ancestor. Local X = -9 so the parent's -1 X scale lands it
    //    at world X = +9, clear of every other box.
    const mirrorParent = new TransformNode("mirrorParent", scene);
    const childBox = box(-9);
    childBox.parent = mirrorParent;

    await scene.whenReadyAsync();

    runtimeBox.scaling.set(-1, 1, 1);
    mirrorParent.scaling.set(-1, 1, 1);

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) {
            eng._drawCalls.fetchNewFrame();
        }
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
    });
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
