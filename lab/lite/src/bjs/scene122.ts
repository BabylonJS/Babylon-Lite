// Scene 122 — BJS reference for Gaussian Splatting SOG parity.
// Mirrors playground QA2662#12: loads via ImportMeshAsync.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/SPLAT/splatFileLoader";

const SPLAT_URL = "https://raw.githubusercontent.com/CedricGuillemet/dump/master/hornedlizard/hornedlizard.sog";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const cam = new ArcRotateCamera("cam", 4.6, 0.956, 3, new Vector3(0, -0.2, 0.2), scene);
    cam.minZ = 0.001;
    cam.maxZ = 1000;
    cam.attachControl(canvas, true);

    await ImportMeshAsync(SPLAT_URL, scene);
    const splat = scene.meshes[0]!;
    splat.rotation.x = Math.PI;

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    const start = performance.now();
    while ((splat as unknown as { _canPostToWorker: boolean })._canPostToWorker !== true && performance.now() - start < 5_000) {
        await new Promise<void>((r) => setTimeout(r, 16));
    }
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));

    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
