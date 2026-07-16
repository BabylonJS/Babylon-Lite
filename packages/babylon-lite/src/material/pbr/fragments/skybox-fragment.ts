/**
 * Skybox-Mode PBR Extension
 *
 * Carries the skybox IBL-sampling WGSL (`IBL_SKYBOX_CALCULATION`, ~1 KB) used when a
 * material opts into `skyboxMode`. The IBL fragment weaves it into its calculation via the
 * `ctx._iblSkyboxCalc` string, sourced by the composer from the `_skyboxCalc` hook on the
 * registered `pbrExt`, so the skybox string bundles only when an app imports `setPbrSkybox`.
 */

import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_SKYBOX } from "../pbr-flag-bits.js";
import { IBL_SKYBOX_CALCULATION } from "./ibl-skybox-wgsl.js";

/** @internal Skybox template hook, carried on the registered `pbrExt` so the always-loaded
 *  composer can feed the skybox IBL-sampling WGSL into the IBL fragment WITHOUT a static
 *  import of the skybox module — the string travels with the ext object, which only exists
 *  once skybox-mode is registered (via {@link setPbrSkybox}). */
export interface SkyboxTemplateHooks {
    /** Skybox IBL-sampling WGSL injected into the IBL calculation. */
    readonly _skyboxCalc: string;
}

/** Skybox extension. Contributes only the `PBR_HAS_SKYBOX` feature bit (via `detect`) plus
 *  the skybox IBL-sampling WGSL (via {@link SkyboxTemplateHooks}). The IBL fragment does the
 *  actual weaving; this ext has no fragment slot / UBO field / binding of its own. */
export const pbrExt: PbrExt & SkyboxTemplateHooks = {
    id: "skybox",
    phase: "fragment",
    _skyboxCalc: IBL_SKYBOX_CALCULATION,
    detect(mat) {
        return { f: (mat as { skyboxMode?: boolean }).skyboxMode ? PBR_HAS_SKYBOX : 0, f2: 0 };
    },
};
