// Scene 110 (BJS reference): RTT with material override.
//
// Mirrors lab/src/lite/scene110.ts — sphere A and box B in main; an offscreen
// 512×512 RTT renders A (with a green override material) from a different
// camera; the RTT color is wired as B's diffuseTexture.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);

    const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2.5, 8, new Vector3(1.5, 0, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 100;
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 1;

    const sphereA = MeshBuilder.CreateSphere("A", { segments: 32, diameter: 1 }, scene);
    const matA_R0 = new StandardMaterial("matA_R0", scene);
    matA_R0.diffuseColor = new Color3(1, 0.2, 0.2);
    sphereA.material = matA_R0;

    const boxB = MeshBuilder.CreateBox("B", { size: 2 }, scene);
    boxB.position.x = 3;

    const rtt = new RenderTargetTexture("rtt-r1", { width: 512, height: 512 }, scene, false);
    rtt.clearColor = new Color4(0.1, 0.1, 0.3, 1);

    const r1Cam = new FreeCamera("r1Cam", new Vector3(0, 0, -3), scene);
    r1Cam.setTarget(Vector3.Zero());
    r1Cam.minZ = 0.1;
    r1Cam.maxZ = 100;
    rtt.activeCamera = r1Cam;

    const matA_R1 = new StandardMaterial("matA_R1", scene);
    matA_R1.diffuseColor = new Color3(0.2, 1, 0.2);
    rtt.setMaterialForRendering(sphereA, matA_R1);

    rtt.renderList = [sphereA];
    scene.customRenderTargets.push(rtt);

    const matB = new StandardMaterial("matB", scene);
    matB.diffuseTexture = rtt;
    boxB.material = matB;

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
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
    engine.runRenderLoop(() => scene.render());
})().catch(console.error);
