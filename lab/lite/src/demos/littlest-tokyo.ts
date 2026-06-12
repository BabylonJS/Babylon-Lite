// Demo — Littlest Tokyo (animated glTF showcase)
// Renders Glen Fox's "Littlest Tokyo" diorama with Babylon Lite: full-fidelity
// (uncompressed) glTF geometry, PBR materials lit by the environment.dds HDR cube
// (the same IBL + background used by Scene 26), and the model's looping animation
// (cars, train, drifting smoke) playing on load. An ArcRotate camera frames the
// city and gently auto-orbits; users can drag to orbit and pause/resume the
// auto-rotation.
//
// Model: "Littlest Tokyo" by Glen Fox — CC Attribution (CC-BY 4.0).
//   Artwork: https://artstation.com/artwork/1AGwX
//   Author:  https://artstation.com/glenatron
//   License: https://creativecommons.org/licenses/by/4.0/

import { addToScene, attachControl, createArcRotateCamera, createBox, createEngine, createPbrMaterial, createSceneContext, createSolidTexture2D, loadGltf, onBeforeRender, playAnimation, rebuildMaterial, registerScene, setCameraLimits, startEngine } from "babylon-lite";
import type { PbrMaterialProps } from "babylon-lite";
import { loadDdsEnvironment } from "babylon-lite/loader-env/load-dds-env";
import { demoAssetUrl, configureDemoDecoderBases } from "./demo-asset-url.js";
import { installFetchProgress } from "./loading-progress.js";

// Same environment cube as Scene 26 — used for both IBL and the visible skybox.
const ENV_URL = "https://playground.babylonjs.com/textures/environment.dds";

// Pleasing pose framing the whole diorama. The model's native units are large
// (~550 across, centred near x≈86, z≈-26); we target the scene centre in X/Z
// and drop the orbit centre slightly below ground (y=-100) to frame the diorama.
// Gentle auto-rotation keeps the showcase lively
// while users can still drag to orbit.
const CAM = {
    alpha: 2.3,
    beta: 1.12,
    radius: 700,
    target: { x: 86, y: -100, z: -26 },
    fov: 0.8,
};
const AUTO_ROTATE_SPEED = 0.12; // radians / second

// Zoom limits: keep the camera outside the diorama (~550 across) so it can't
// clip inside the geometry, and stop it drifting so far the model shrinks away.
const MIN_RADIUS = 320;
const MAX_RADIUS = 1000;

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const progress = installFetchProgress(canvas, { estimatedBytes: 11_500_000 });

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const cam = createArcRotateCamera(CAM.alpha, CAM.beta, CAM.radius, CAM.target);
    cam.fov = CAM.fov;
    cam.nearPlane = 1;
    cam.farPlane = 5000;
    scene.camera = cam;
    attachControl(cam, canvas, scene);

    // Orbit/zoom limits enforced by attachControl's per-frame loop (no jiggle):
    //  • radius — keep the camera outside the diorama (~550 across) so it can't
    //    clip into the geometry, and stop it drifting so far the model shrinks away.
    //  • beta — never let the eye dip below the diorama's "surface"
    //    (eye.y = target.y + r·cos(beta), so beta > π/2 puts the eye underneath);
    //    a tiny epsilon avoids the exactly-horizontal singularity.
    setCameraLimits(
        cam,
        {
            lowerRadiusLimit: MIN_RADIUS,
            upperRadiusLimit: MAX_RADIUS,
            upperBetaLimit: Math.PI / 2 - 0.001,
        },
        scene,
    );

    // Point the glTF decoders at the demo-local files so they resolve under any
    // base path (e.g. /lite-demos/) rather than the site root.
    await configureDemoDecoderBases(import.meta.url);

    await Promise.all([
        loadGltf(engine, demoAssetUrl("./littlest-tokyo/LittlestTokyo.glb", import.meta.url)).then((asset) => {
            addToScene(scene, asset);
            // Play every clip on a continuous loop so the diorama animates immediately.
            for (const group of asset.animationGroups ?? []) {
                group.loopAnimation = true;
                playAnimation(group);
            }
        }),
        loadDdsEnvironment(scene, ENV_URL, {
            // IBL only here — the visible background is the scene-level PBR skybox
            // box built below (so background and IBL share this same env cube).
            skipSkybox: true,
            skipGround: true,
            brdfUrl: demoAssetUrl("./brdf-lut.png", import.meta.url),
        }),
    ]);

    // Neutral, slightly warm grading so the PBR materials read as a sunny day.
    scene.imageProcessing.toneMappingEnabled = true;
    scene.imageProcessing.exposure = 1.35;
    scene.imageProcessing.contrast = 1.0;

    // Gentle auto-orbit (demos carry no golden-parity obligation). The user can
    // pause/resume it via the on-screen toggle, and ANY direct interaction with
    // the canvas (drag, wheel, pinch) stops auto-rotation without auto-restarting
    // it — it only resumes when the user explicitly toggles it back on.
    let autoRotate = true;
    const toggleBtn = document.getElementById("autoRotateToggle") as HTMLButtonElement | null;
    function setAutoRotate(on: boolean): void {
        autoRotate = on;
        if (toggleBtn) {
            toggleBtn.textContent = on ? "⏸ Auto-rotate" : "▶ Auto-rotate";
            toggleBtn.setAttribute("aria-pressed", String(on));
        }
    }
    setAutoRotate(true);
    toggleBtn?.addEventListener("click", () => setAutoRotate(!autoRotate));

    // Stop auto-rotation as soon as the user interacts; do NOT auto-restart.
    const stopOnInteract = (): void => {
        if (autoRotate) {
            setAutoRotate(false);
        }
    };
    canvas.addEventListener("pointerdown", stopOnInteract);
    canvas.addEventListener("wheel", stopOnInteract, { passive: true });
    canvas.addEventListener("touchstart", stopOnInteract, { passive: true });

    // Keep the orbit at or above the target's Y plane (see setCameraLimits above).
    let last = performance.now();
    onBeforeRender(scene, () => {
        const now = performance.now();
        if (autoRotate) {
            cam.alpha += (AUTO_ROTATE_SPEED * (now - last)) / 1000;
        }
        last = now;
    });

    // Visible HDR background matching the IBL: a PBR skybox-mode box that samples
    // the same environment cube along the view ray (mirrors Scene 26's background).
    // Sized to fill the frustum and pinned to the camera so it always reads as sky.
    const skybox = createBox(engine, (cam.farPlane - cam.nearPlane) / 2);
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

    await registerScene(scene);

    // The asset's "metalmat" material bakes an ambient-occlusion texture sampled
    // on a second UV set the metal meshes don't cleanly provide, which renders as
    // dark smears across the metalwork. Swap the occlusion map for a flat-white 1×1
    // texture: this removes the ambient-occlusion effect while keeping the material's
    // texture-binding layout identical, then rebuild the affected renderables.
    const metalMat = scene.meshes.map((m) => m.material).find((mat): mat is PbrMaterialProps => !!mat && mat.name === "metalmat");
    if (metalMat?.occlusionTexture) {
        metalMat.occlusionTexture = createSolidTexture2D(engine, 1, 1, 1);
        rebuildMaterial(scene, metalMat, { rebuildFrameGraph: true });
    }

    progress.done();
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
