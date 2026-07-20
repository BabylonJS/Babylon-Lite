// Scene 266 — BJS reference for Gaussian Splatting glTF parity.
// Mirrors playground #WSAFDA#0: loads Halo_Believe.glb (KHR_gaussian_splatting)
// via ImportMeshAsync and waits for the first worker sort to land before ready.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
// Registers the glTF file loader plugin AND all its 2.0 extensions (incl. KHR_gaussian_splatting).
import "@babylonjs/loaders/glTF";

const GLB_URL = "https://assets.babylonjs.com/splats/gltf/Halo_Believe.glb";

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

    await ImportMeshAsync(GLB_URL, scene);
    const splat = scene.meshes.find((m) => (m as unknown as { _canPostToWorker?: boolean })._canPostToWorker !== undefined) ?? scene.meshes[0]!;

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
