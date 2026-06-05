/**
 * Demo — Offscreen, shared scene.
 *
 * A single, completely DOM-free scene builder used by BOTH render paths of the
 * Offscreen demo:
 *   - the main thread, rendering into a regular `<canvas>`, and
 *   - a Web Worker, rendering into an `OffscreenCanvas` transferred to it.
 *
 * It renders the glTF "Flight Helmet" PBR model (the same asset the babylon.js
 * Offscreen demo uses) inside a studio environment (image-based lighting + DDS
 * skybox + reflective ground), with the camera slowly orbiting it. Crucially the
 * whole thing is built with only worker-safe APIs — `fetch`, `createImageBitmap`,
 * `OffscreenCanvas`, dynamic `import()` — and it never touches `window` or
 * `document`, so the EXACT same code produces the EXACT same image whether it
 * runs on the main thread or inside a Web Worker. That's the whole point of the
 * demo: the only difference between the two canvases is WHERE the Lite engine
 * runs, not WHAT it renders.
 */
import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createDefaultCamera,
    createHemisphericLight,
    loadGltf,
    loadEnvironment,
    onBeforeRender,
    registerScene,
    type EngineContext,
    type RenderCanvas,
} from "babylon-lite";
import { configureDemoDecoderBases, demoAssetUrl } from "./demo-asset-url.js";

// Same CDN assets used by the existing Flight Helmet scene (lab scene 14):
// PBR model, .env IBL, DDS skybox and a reflective ground texture.
const MODEL_URL = "https://assets.babylonjs.com/meshes/flightHelmet.glb";
const ENV_URL = "https://assets.babylonjs.com/core/environments/environmentSpecular.env";
const SKYBOX_URL = "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds";
const GROUND_URL = "https://assets.babylonjs.com/core/environments/backgroundGround.png";
export const BRDF_ASSET = demoAssetUrl("./brdf-lut.png", import.meta.url);

/**
 * Build, register and start the Offscreen demo scene on the given canvas/offscreen.
 * Resolves once the first frame has rendered. The returned engine is the live
 * `EngineContext` (used by the worker to push resize events via `setEngineSize`).
 *
 * @param brdfUrl Absolute URL for the PBR BRDF LUT. Must be passed by the caller
 *   (resolved against the document) so it loads correctly inside a worker.
 */
export async function startOffscreenScene(canvas: RenderCanvas, brdfUrl: string = BRDF_ASSET): Promise<EngineContext> {
    await configureDemoDecoderBases(import.meta.url);

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // PBR model + studio environment (IBL, DDS skybox, reflective ground). All the
    // asset I/O below uses fetch + createImageBitmap, which work identically on the
    // main thread and inside a worker.
    const helmet = await loadGltf(engine, MODEL_URL);
    addToScene(scene, helmet);
    await loadEnvironment(scene, ENV_URL, {
        skyboxUrl: SKYBOX_URL,
        skyboxSize: 1000,
        groundTextureUrl: GROUND_URL,
        brdfUrl: brdfUrl,
    });

    // Soft fill on top of the IBL so the shadowed side isn't pure black.
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    // Frame the model, then nudge to a flattering three-quarter view.
    const camera = createDefaultCamera(scene);
    camera.alpha = Math.PI * 0.5 + 0.4;
    camera.beta = 1.28;
    camera.radius *= 0.85;
    scene.camera = camera;

    // Turntable: orbit the camera around the model each frame. Camera matrices are
    // recomputed every frame, so this animates reliably on both the main thread and
    // inside the worker (unlike animating a parent transform node).
    onBeforeRender(scene, () => {
        camera.alpha += 0.0035;
    });

    await registerScene(engine, scene);
    await startEngine(engine);
    return engine;
}
