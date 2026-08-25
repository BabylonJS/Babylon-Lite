/**
 * World — environment loading. After the Part unification  the
 * ground is a locked baseplate Part like everything else; only the skybox
 * remains special.
 */

import type { SceneContext } from "babylon-lite";
import { loadSkybox } from "babylon-lite";

/** BabylonJS playground skybox — blue sky with clouds (Apache 2.0). */
const SKYBOX_BASE_URL = "https://playground.babylonjs.com/textures/TropicalSunnyDay";
const SKYBOX_EXT = ".jpg";
const SKYBOX_SIZE = 10000;

export async function loadWorldSkybox(scene: SceneContext): Promise<void> {
    await loadSkybox(scene, SKYBOX_BASE_URL, SKYBOX_EXT, SKYBOX_SIZE);
}
