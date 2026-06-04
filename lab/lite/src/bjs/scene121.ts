// Scene 121 — BJS reference for the Gaussian-Splatting `updateData` parity
// scene. Port of playground https://playground.babylonjs.com/#RKKCHG#15.
//
// Loads Halo_Believe.splat with `keepInRam:true` so `gs.splatsData` is
// retained, modifies the first 30 000 splats' Y by -2, then calls
// `gs.updateData(buffer, undefined, {flipY:false})`. The mesh is exposed on
// `window.__gs` so the uncommitted parity test can read the post-update
// `splatsData` and compare byte-for-byte against the Lite reference scene.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { GaussianSplattingMesh } from "@babylonjs/core/Meshes/GaussianSplatting/gaussianSplattingMesh";
import "@babylonjs/loaders/SPLAT/splatFileLoader";

const SPLAT_URL = "https://raw.githubusercontent.com/CedricGuillemet/dump/master/Halo_Believe.splat";

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const cam = new ArcRotateCamera("cam", -1, 1, 10, new Vector3(0, 0, 0), scene);
    cam.minZ = 0.1;
    cam.maxZ = 100;
    cam.attachControl(canvas, true);

    // keepInRam=true so `gs.splatsData` is retained for the round-trip below.
    const gs = new GaussianSplattingMesh("Halo", SPLAT_URL, scene, true);
    await gs.loadFileAsync(SPLAT_URL);

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    // Wait for at least one frame after BJS' first worker sort lands.
    const start = performance.now();
    while ((gs as unknown as { _canPostToWorker: boolean })._canPostToWorker !== true && performance.now() - start < 5_000) {
        await new Promise<void>((r) => setTimeout(r, 16));
    }
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));

    // Translate the first 30 000 splats by Y -= 2 (mirrors the playground).
    const buf = gs.splatsData!;
    const positions = new Float32Array(buf);
    for (let i = 0; i < 30000; i++) {
        positions[i * 8 + 1]! -= 2.0;
    }
    gs.updateData(buf, undefined, { flipY: false });

    gs.scaling.y = -1;
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));

    (window as unknown as { __gs: GaussianSplattingMesh }).__gs = gs;

    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
