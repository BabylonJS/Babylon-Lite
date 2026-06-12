// Scene 129 — Gaussian Splatting GPU Picking (Lite, minimal port).
// Port of playground https://playground.babylonjs.com/#3LNCE6#36 — extends Lite
// GPU picking to handle Gaussian-Splatting meshes through the
// `gsGpuPickingFragment` plugin (Lite equivalent of BJS
// `GaussianSplattingGpuPickingMaterialPlugin`) and the dedicated GS picking
// pipeline.
//
// Minimal scope (confirmed with user): a single GS mesh + sphere + ground.
// No compound parts, no GizmoManager, no GUI — clicking the canvas writes the
// picked mesh name to `canvas.dataset.pickedHit` for parity / scripting.
//
// Visual indicator: the ground is shown when the deterministic pick hits the
// GS mesh ("renderMesh") and hidden when the pick misses, making the picker
// integration result visible at a glance in the rendered scene.  The result is
// also logged via console.log for inspection.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createGpuPicker,
    createGround,
    createHemisphericLight,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    disposePicker,
    loadSplat,
    pickAsync,
    registerScene,
    removeFromScene,
    startEngine,
} from "babylon-lite";

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

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1 };

    const camera = createArcRotateCamera(-1, 1, 10, { x: 0, y: 0, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.7));

    const sphereMat = createStandardMaterial();
    const sphere = createSphere(engine, { diameter: 1, segments: 32 });
    sphere.name = "sphere";
    sphere.position.y = 0.5;
    sphere.position.z = -1;
    sphere.material = sphereMat;
    addToScene(scene, sphere);

    const groundMat = createStandardMaterial();
    const ground = createGround(engine, { width: 6, height: 6 });
    ground.name = "ground";
    ground.material = groundMat;
    addToScene(scene, ground);

    const splat = await loadSplat(scene, SPLAT_URL);
    splat.name = "renderMesh";
    splat.position.y = 1.7;

    await registerScene(scene);
    await startEngine(engine);

    await splat.firstSortReady;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    const picker = createGpuPicker(scene);

    // Wire interactive click-to-pick.  Each pick writes the hit name onto the
    // canvas dataset so the page is scriptable for parity tests.
    canvas.addEventListener("pointerdown", async (e) => {
        const info = await pickAsync(picker, e.offsetX, e.offsetY);
        canvas.dataset.lastPickCss = `${e.offsetX},${e.offsetY}`;
        canvas.dataset.lastPickedHit = info.hit ? (info.pickedMesh?.name ?? "") : "miss";
    });

    // Deterministic pick for parity:  one fixed sample at the configured ratio
    // (defaults to the screen centre, which lands on the GS mesh).
    const [pickXRatio, pickYRatio] = getPickRatios();
    const pickX = canvas.clientWidth * pickXRatio;
    const pickY = canvas.clientHeight * pickYRatio;
    const pickInfo = await pickAsync(picker, pickX, pickY);
    disposePicker(picker);

    const pickedName = pickInfo.hit ? (pickInfo.pickedMesh?.name ?? "") : "miss";
    // eslint-disable-next-line no-console
    console.log(`[scene129/lite] GPU pick at (${pickX.toFixed(1)}, ${pickY.toFixed(1)}) → ${pickedName}`);

    // Hide the ground when the pick didn't land on the GS mesh — makes the
    // picker outcome visible in the rendered scene without depending on
    // material colour.
    if (pickedName !== "renderMesh") {
        removeFromScene(scene, ground);
    }

    // Wait one frame so the visibility change is in the screenshot.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.pickCss = `${pickX.toPrecision(12)},${pickY.toPrecision(12)}`;
    canvas.dataset.pickedHit = pickedName;
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
