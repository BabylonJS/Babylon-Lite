// Scene 129 — BJS reference for Gaussian Splatting GPU Picking.
// Minimal port of https://playground.babylonjs.com/#3LNCE6#36: a single GS mesh,
// a regular sphere and a ground; GPU picking writes the hit mesh name onto the
// canvas dataset for parity testing.  No compound parts / gizmo / GUI (the user
// confirmed a minimal port for scene 129).
//
// Visual indicator: the ground is shown when the deterministic pick hits the GS
// mesh ("renderMesh") and hidden when the pick misses, making the picker
// integration result visible at a glance in the rendered scene.  The result is
// also logged via console.log for inspection.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { GPUPicker } from "@babylonjs/core/Collisions/gpuPicker";
import "@babylonjs/loaders/SPLAT/splatFileLoader";

const SPLAT_URL = "https://raw.githubusercontent.com/CedricGuillemet/dump/master/Halo_Believe.splat";
// Screen-centre coordinates pick the GS mesh in both BJS and Lite (the
// renderMesh quads cover most of the rendered area for this splat).
const DEFAULT_PICK_X_RATIO = 0.5;
const DEFAULT_PICK_Y_RATIO = 0.6;

function getPickRatios(): [number, number] {
    const params = new URLSearchParams(window.location.search);
    const px = parseFloat(params.get("pickX") || "");
    const py = parseFloat(params.get("pickY") || "");
    return [Number.isFinite(px) ? px : DEFAULT_PICK_X_RATIO, Number.isFinite(py) ? py : DEFAULT_PICK_Y_RATIO];
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);

    const camera = new ArcRotateCamera("camera1", -1, 1, 10, new Vector3(0, 0, 0), scene);
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 1, segments: 32 }, scene);
    sphere.position.y = 0.5;
    sphere.position.z = -1;

    const ground = MeshBuilder.CreateGround("ground", { width: 6, height: 6 }, scene);

    const result = await ImportMeshAsync(SPLAT_URL, scene);
    const gs = result.meshes[0]!;
    gs.name = "renderMesh";
    gs.position.y = 1.7;

    const gpuPicker = new GPUPicker();
    gpuPicker.setPickingList([gs, sphere, ground]);

    canvas.addEventListener("pointerdown", async (e) => {
        const pick = await gpuPicker.pickAsync(e.offsetX, e.offsetY);
        canvas.dataset.lastPickCss = `${e.offsetX},${e.offsetY}`;
        canvas.dataset.lastPickedHit = pick && pick.mesh ? pick.mesh.name : "miss";
    });

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    const start = performance.now();
    while ((gs as unknown as { _canPostToWorker: boolean })._canPostToWorker !== true && performance.now() - start < 5_000) {
        await new Promise<void>((r) => setTimeout(r, 16));
    }
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));

    const [pickXRatio, pickYRatio] = getPickRatios();
    const pickX = canvas.clientWidth * pickXRatio;
    const pickY = canvas.clientHeight * pickYRatio;
    const pickInfo = await gpuPicker.pickAsync(pickX, pickY);

    const pickedName = pickInfo && pickInfo.mesh ? pickInfo.mesh.name : "miss";
    // eslint-disable-next-line no-console
    console.log(`[scene129/bjs] GPU pick at (${pickX.toFixed(1)}, ${pickY.toFixed(1)}) → ${pickedName}`);

    // Hide the ground when the pick didn't land on the GS mesh — makes the
    // picker outcome visible in the rendered scene without depending on
    // material colour (BJS GPUPicker is known to alter non-GS material
    // colours when a GS mesh is in the picking list).
    if (pickedName !== "renderMesh") {
        ground.setEnabled(false);
    }

    // Wait one frame so the visibility change is in the screenshot.
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));

    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.pickCss = `${pickX.toPrecision(12)},${pickY.toPrecision(12)}`;
    canvas.dataset.pickedHit = pickedName;
    canvas.dataset.ready = "true";
})().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
