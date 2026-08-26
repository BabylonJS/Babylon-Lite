// Demo — Calculator (glTF KHR_interactivity showcase)
//
// Loads the Khronos "Calculator" sample glb and runs its embedded
// KHR_interactivity graph with Babylon Lite's flow-graph runtime. On load the
// graph's `event/onStart` chain fires: it resets the two display digits to "00"
// by driving `pointer/set` on the digit materials' KHR_texture_transform offset
// (the digit atlas is scrolled so both wheels show "0"), hides the minus sign
// via KHR_node_visibility, and seeds the calculator's scene variables. The math
// blocks (add/sub/mul/div/rem/abs/floor/lt/clamp + combine2/extract2) and the
// pointer get/set accessors are all exercised by this graph.
//
// KHR_interactivity is still evolving; the loader keeps its spec-dependent
// parser and pointer mapping isolated so future Khronos revisions stay local.
//
// Model: "Calculator" from the Khronos glTF-Test-Assets-Interactivity repo
//   https://github.com/KhronosGroup/glTF-Test-Assets-Interactivity (CC0 / public
//   domain test asset). The directional light ships in the glb via
//   KHR_lights_punctual; a studio HDR cube is loaded for PBR image-based lighting.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createSceneContext,
    enableFlowGraphPointerPicking,
    loadGltf,
    onBeforeRender,
    registerScene,
    setCameraLimits,
    startEngine,
} from "babylon-lite";
import { loadDdsEnvironment } from "babylon-lite/loader-env/load-dds-env";
import { configureDemoDecoderBases, demoAssetUrl } from "./demo-asset-url.js";
import { installFetchProgress } from "./loading-progress.js";

// Studio HDR cube used for image-based lighting only (no visible skybox — the
// calculator reads as a clean product shot on a neutral background).
const ENV_URL = "https://playground.babylonjs.com/textures/environment.dds";

// ArcRotate pose reconstructed from the glb's authored "Main Camera" (eye at
// roughly (-0.07, 1.59, 1.72) looking down on the calculator lying flat on the
// XZ plane, display at the far -Z edge, buttons toward +Z). Targets the body
// centre and looks down the authored ~44° tilt.
const CAM = {
    alpha: 1.6115,
    beta: 0.8736,
    radius: 2.2443,
    target: { x: 0, y: 0.15, z: 0 },
    fov: 1.0471975, // glb Main Camera yfov (60°)
};

// Gentle auto-rotation so the showcase slowly turns; paused while the user
// interacts and for a short grace period afterwards.
const AUTO_ROTATE_SPEED = 0.0025; // radians per frame
const IDLE_DELAY_MS = 2500;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const progress = installFetchProgress(canvas, { estimatedBytes: 1_900_000 });

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const cam = createArcRotateCamera(CAM.alpha, CAM.beta, CAM.radius, CAM.target);
    cam.fov = CAM.fov;
    scene.camera = cam;
    attachControl(cam, canvas, scene);
    setCameraLimits(
        cam,
        {
            lowerRadiusLimit: CAM.radius * 0.45,
            upperRadiusLimit: CAM.radius * 2.5,
        },
        scene,
    );

    // The model is uncompressed, but configure the decoder bases anyway so the
    // demo stays subpath-safe if the asset is ever re-exported compressed.
    await configureDemoDecoderBases(import.meta.url);

    const [asset] = await Promise.all([
        loadGltf(engine, demoAssetUrl("./Calculator.glb", import.meta.url)),
        loadDdsEnvironment(scene, ENV_URL, {
            skipSkybox: true,
            skipGround: true,
            brdfUrl: demoAssetUrl("./brdf-lut.png", import.meta.url),
        }),
    ]);
    addToScene(scene, asset);

    await asset.flowGraphRuntimes;
    await enableFlowGraphPointerPicking(scene);

    // Slow continuous orbit, paused during/after user interaction so it never
    // fights a manual orbit or zoom.
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

    await registerScene(scene);
    progress.done();
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
