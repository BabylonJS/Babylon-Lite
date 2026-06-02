// Scene 120 — BJS reference for Gaussian Splatting parity.
// Loads the same Halo_Believe.ply via @babylonjs/core's GaussianSplattingMesh
// and waits for the first worker sort to land before flagging ready.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { GaussianSplattingMesh } from "@babylonjs/core/Meshes/GaussianSplatting/gaussianSplattingMesh";
import "@babylonjs/loaders/SPLAT/splatFileLoader";

const SPLAT_URL = "https://assets.babylonjs.com/splats/Halo_Believe.ply";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const cam = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2.5, 6, new Vector3(0, 0, 0), scene);
    cam.minZ = 0.1;
    cam.maxZ = 100;
    cam.attachControl(canvas, true);

    const splat = new GaussianSplattingMesh("splat", null, scene);
    await splat.loadFileAsync(SPLAT_URL);

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    // Wait for at least one frame after BJS' first worker sort lands. The
    // worker callback flips _canPostToWorker back to true once it has
    // updated the splatIndex buffer; poll briefly and then settle on a frame.
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
