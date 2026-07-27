// Babylon.js reference for Scene 269: Runtime mesh swap with a shared material texture.
//
// Mirrors the Lite scene move for move: the source box is disposed from inside the render loop and a
// clone of it — sharing the same material, texture and geometry — is enabled in its place. BJS
// ref-counts the shared geometry per mesh and does not dispose a mesh's material by default, so the
// clone survives the source's disposal. The golden image is therefore the post-swap state.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

const SWAP_FRAME = 20;
const SETTLE_FRAMES = 30;

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.06, 0.09, 1);

    const camera = new ArcRotateCamera("cam", -Math.PI / 2, 1.1, 6, new Vector3(0, 0.9, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 50;
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    light.intensity = 1.0;

    const box = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    box.position = new Vector3(0, 0.5, 0);
    const boxMat = new StandardMaterial("box-mat", scene);
    boxMat.diffuseColor = new Color3(0.85, 0.34, 0.2);
    boxMat.specularColor = Color3.Black();
    // 1x1 white — matches Lite's createSolidTexture2D(engine, 1, 1, 1, 1).
    boxMat.diffuseTexture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
    box.material = boxMat;

    const ground = MeshBuilder.CreateGround("ground", { width: 8, height: 8 }, scene);
    const groundMat = new StandardMaterial("ground-mat", scene);
    groundMat.diffuseColor = new Color3(0.2, 0.23, 0.27);
    groundMat.specularColor = Color3.Black();
    ground.material = groundMat;

    // Clone shares material (and therefore the texture) plus the ref-counted geometry. Held out of
    // the render until the swap so the pre-swap frames match Lite's, where it is not yet in the scene.
    const clone = box.clone("box-clone");
    clone.position = new Vector3(0, 1.75, 0);
    clone.setEnabled(false);

    engine.getDeltaTime = function () {
        return 16;
    };
    scene.useConstantAnimationDeltaTime = true;

    let frame = 0;
    let swapped = false;
    scene.onBeforeRenderObservable.add(() => {
        frame++;
        if (!swapped && frame >= SWAP_FRAME) {
            swapped = true;
            box.dispose();
            clone.setEnabled(true);
            canvas.dataset.swapped = "true";
        }
        if (swapped && frame >= SWAP_FRAME + SETTLE_FRAMES) {
            canvas.dataset.ready = "true";
        }
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    canvas.dataset.loaded = "true";
    canvas.dataset.initMs = String(performance.now() - __initStart);
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
