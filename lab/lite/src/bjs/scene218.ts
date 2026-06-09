// BJS reference oracle for Scene 218 (Vertex Animation Texture).
//
// VAT must reproduce the LIVE skeletal animation exactly, so the ground-truth golden is the same shark
// rendered with Babylon.js's live skeleton (identical to scene 11), frozen at an integer frame via
// ?seekTime. Lite scene 218 renders the SAME pose from its baked VAT texture — if VAT is correct, the two
// match to the same tolerance as the live scene-11 parity test.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.14, 0.14, 0.16, 1.0);

    const result = await SceneLoader.ImportMeshAsync("", "https://models.babylonjs.com/", "shark.glb", scene);

    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const m of result.meshes) {
        m.refreshBoundingInfo({});
        const bi = m.getBoundingInfo();
        min = Vector3.Minimize(min, bi.boundingBox.minimumWorld);
        max = Vector3.Maximize(max, bi.boundingBox.maximumWorld);
    }
    const center = Vector3.Center(min, max);
    const diag = max.subtract(min).length();
    const radius = diag * 1.5;

    const cam = new ArcRotateCamera("cam", 0, Math.PI / 2.2, radius, center, scene);
    cam.minZ = radius * 0.01;
    cam.maxZ = radius * 1000;

    new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);

    for (const g of scene.animationGroups) {
        if (g.name !== "swimming") {
            g.stop();
        }
    }

    engine.getDeltaTime = function () {
        return 16;
    };
    scene.useConstantAnimationDeltaTime = true;

    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");

    let frameCount = 0;
    let seekDone = false;
    scene.onBeforeRenderObservable.add(() => {
        frameCount++;
        canvas.dataset.frameCount = String(frameCount);

        if (!isNaN(seekTimeParam) && seekTimeParam >= 0 && frameCount === 10 && !seekDone) {
            const seekFrame = seekTimeParam * 60;
            scene.animationGroups.forEach((g) => g.goToFrame(seekFrame));
            scene.animatables.forEach((a) => a.pause());
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
        }

        if (!seekDone && frameCount === 300) {
            scene.animatables.forEach((a) => a.pause());
            canvas.dataset.animationFrozen = "true";
        }
    });

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
