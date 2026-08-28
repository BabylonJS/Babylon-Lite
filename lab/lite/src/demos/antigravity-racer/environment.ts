import type { SceneContext } from "babylon-lite";
import { loadEnvironment } from "babylon-lite";

import { demoAssetUrl } from "../demo-asset-path.js";

/** Prefiltered sibling of the HDR used by Playground CGA05F#831. */
export const RACER_ENVIRONMENT_URL = "https://playground.babylonjs.com/textures/environment.env";

/** Add the Playground environment as both IBL and the visible sky. */
export async function loadRacerEnvironment(scene: SceneContext): Promise<void> {
    await loadEnvironment(scene, RACER_ENVIRONMENT_URL, {
        brdfUrl: demoAssetUrl("./brdf-lut.png", import.meta.url),
        skyboxUrl: RACER_ENVIRONMENT_URL,
        skyboxSize: 1000,
        skipGround: true,
    });

    // CGA05F#831 uses Babylon's raw HDR defaults rather than tone mapping.
    scene.imageProcessing.toneMappingEnabled = false;
    scene.imageProcessing.exposure = 1;
    scene.imageProcessing.contrast = 1;
}
