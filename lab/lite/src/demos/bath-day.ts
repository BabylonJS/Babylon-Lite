// Demo — Bath Day (animated, Draco-compressed glTF diorama)
//
// Showcase-only page (pure Lite, no BJS comparison, no parity/golden
// obligations). Loads StanSt's "Bath Day" diorama — a frog taking a bath
// surrounded by candles, water and plants. The model (CC BY 4.0) is vendored
// in-repo at lab/public/bath_day.glb and copied next to the demo bundle at
// build time, so it loads relative to the page. The model is Draco-compressed,
// so the Draco decoder base URL is configured before loading. The environment
// (DDS cubemap IBL + a
// visible PBR skybox, ACES tone mapping at exposure 1.6) matches Scene 26.
//
// Model attribution (CC BY 4.0):
//   "Bath Day" by StanSt (https://sketchfab.com/stanst), CC BY 4.0
//
// The model is animated; addToScene() registers its animationGroups with the
// scene-owned AnimationManager and the engine auto-plays them, so the frog,
// candles, water and plants animate without any manual play call.

import {
    addToScene,
    attachControl,
    createBox,
    createDefaultCamera,
    createEngine,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    getFrameGraph,
    loadGltf,
    onBeforeRender,
    registerScene,
    startEngine,
    type RenderTask,
} from "babylon-lite";
import { loadDdsEnvironment } from "babylon-lite/loader-env/load-dds-env";
import { configureDemoDracoBase, demoAssetUrl } from "./demo-asset-url.js";

const ENV_URL = "https://playground.babylonjs.com/textures/environment.dds";

// Gentle auto-rotation so the diorama slowly showcases itself.
const AUTO_ROTATE_SPEED = 0.0035; // radians per frame
// After the user stops interacting, wait this long before resuming auto-rotation.
const IDLE_DELAY_MS = 2500;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // The bubbles, jar and shampoo bottle use KHR_materials_transmission, which
    // needs the frame-graph scene-texture transmission copy to refract the scene
    // behind them. Without it they render as dull near-opaque blobs.
    (getFrameGraph(scene)._tasks[0] as RenderTask)._config.transmission = { copyCount: 1 };

    // Image processing: ACES tone mapping, exposure 1.6 (matches Scene 26).
    scene.imageProcessing.exposure = 1.6;
    scene.imageProcessing.toneMappingEnabled = true;
    scene.imageProcessing.toneMappingType = "aces";

    // Draco-compressed glTF — point the decoder at the demo-local wasm/js.
    await configureDemoDracoBase(import.meta.url);

    // Load the model + DDS cubemap environment in parallel (same env as Scene 26).
    await Promise.all([
        loadGltf(engine, demoAssetUrl("./bath_day.glb", import.meta.url)).then((asset) => addToScene(scene, asset)),
        loadDdsEnvironment(scene, ENV_URL, {
            brdfUrl: demoAssetUrl("./brdf-lut.png", import.meta.url),
        }),
    ]);

    // Auto-frame the loaded diorama, then nudge the pose to a pleasant 3/4 view
    // looking slightly down on the bath.
    const cam = createDefaultCamera(scene);
    cam.beta = 1.15;
    cam.radius *= 0.62;
    attachControl(cam, canvas, scene);

    // Visible PBR skybox that samples the cubemap as the background (Scene 26's
    // SKYBOX_MODE block). The box is recentred on the camera each frame so it
    // always surrounds the viewer. The bath model is tiny, so the auto-framed
    // radius — and the camera's radius-derived far plane — are small; size the
    // box relative to cam.radius (instead of Scene 26's fixed 5) and widen the
    // far plane so the skybox is never clipped.
    const skyboxSize = cam.radius * 4;
    cam.farPlane = Math.max(cam.farPlane, skyboxSize * 4);
    const skybox = createBox(engine, skyboxSize);
    skybox.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
        ormTexture: createSolidTexture2D(engine, 1.0, 0.3, 1.0), // occ=1, rough=0.3, metal=1 → F0=(1,1,1)
        environmentIntensity: 1.008,
        directIntensity: 0,
        doubleSided: true,
        skyboxMode: true,
    });
    const syncSkybox = (): void => {
        const w = cam.worldMatrix;
        skybox.position.set(w[12]!, w[13]!, w[14]!);
    };
    syncSkybox();
    onBeforeRender(scene, syncSkybox);
    addToScene(scene, skybox);

    // Slow continuous orbit, paused while the user interacts and for a grace
    // period afterwards. We advance alpha only once the camera has been idle for
    // IDLE_DELAY_MS so auto-rotation never fights a manual orbit/zoom.
    let lastInteractionMs = -Infinity;
    const markInteraction = (): void => {
        lastInteractionMs = performance.now();
    };
    canvas.addEventListener("pointerdown", markInteraction);
    canvas.addEventListener("wheel", markInteraction, { passive: true });
    canvas.addEventListener("pointermove", (e) => {
        if (e.buttons !== 0) {
            markInteraction();
        }
    });
    canvas.addEventListener("touchstart", markInteraction, { passive: true });
    canvas.addEventListener("touchmove", markInteraction, { passive: true });

    // "Auto-rotate" toggle button: lets the viewer stop the auto-orbit entirely.
    // Matches the Littlest Tokyo demo's control UI.
    let autoRotateEnabled = true;
    const rotateBtn = document.getElementById("rotateToggle");
    if (rotateBtn) {
        rotateBtn.addEventListener("click", () => {
            autoRotateEnabled = !autoRotateEnabled;
            rotateBtn.textContent = autoRotateEnabled ? "⏸ Auto-rotate" : "▶ Auto-rotate";
            rotateBtn.setAttribute("aria-pressed", String(autoRotateEnabled));
        });
    }

    onBeforeRender(scene, () => {
        if (autoRotateEnabled && performance.now() - lastInteractionMs > IDLE_DELAY_MS) {
            cam.alpha += AUTO_ROTATE_SPEED;
        }
    });

    await registerScene(engine, scene);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.camAlpha = String(cam.alpha);
    canvas.dataset.camBeta = String(cam.beta);
    canvas.dataset.camRadius = String(cam.radius);
    canvas.dataset.camTarget = `${cam.target.x},${cam.target.y},${cam.target.z}`;
    canvas.dataset.camFov = String(cam.fov);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
