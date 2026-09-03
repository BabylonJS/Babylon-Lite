import type { SceneContext } from "babylon-lite";
import { loadHdrEnvironment, setFog } from "babylon-lite";

import { RACER_FOG_COLOR, RACER_FOG_END, RACER_FOG_MODE, RACER_FOG_START } from "./constants.js";

/** Exact raw environment used by Playground CGA05F#831. */
export const RACER_ENVIRONMENT_URL = "https://playground.babylonjs.com/textures/environment.hdr";
/** Explicit origin prevents EnvironmentHelper-style world-bounds sizing from pushing the skybox past the camera far plane. */
export const RACER_SKYBOX_POSITION: [number, number, number] = [0, 0, 0];

/** Add the Playground environment as both IBL and the visible sky. */
export async function loadRacerEnvironment(scene: SceneContext): Promise<void> {
    await loadHdrEnvironment(scene, RACER_ENVIRONMENT_URL, {
        faceSize: 512,
        useCubemapSkybox: true,
        skyboxSize: 1000,
        skyboxPosition: RACER_SKYBOX_POSITION,
        skipGround: true,
    });

    // CGA05F#831 uses Babylon's raw HDR defaults rather than tone mapping.
    scene.imageProcessing.toneMappingEnabled = false;
    scene.imageProcessing.exposure = 1;
    scene.imageProcessing.contrast = 1;
    setFog(scene, {
        mode: RACER_FOG_MODE,
        density: 0,
        start: RACER_FOG_START,
        end: RACER_FOG_END,
        color: RACER_FOG_COLOR,
    });
}
