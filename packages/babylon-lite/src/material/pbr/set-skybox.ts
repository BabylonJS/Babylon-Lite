/** Skybox-mode PBR material opt-in.
 *
 *  Statically imports the skybox fragment's `pbrExt`; the skybox IBL-sampling WGSL bundles
 *  only when an app imports `setPbrSkybox`. No always-loaded `skyboxMode` scan or skybox
 *  WGSL import specifier remains in the renderable's shared chunk. */

import type { PbrMaterialProps } from "./pbr-material.js";
import { pbrExt } from "./fragments/skybox-fragment.js";
import { _registerPbrExt } from "./pbr-flags.js";

/** Turn `mat` into a skybox material that samples the scene IBL cubemap along the view
 *  direction (use on a large camera-centred box). Registers the skybox extension globally
 *  (idempotent). Requires the scene to have an environment (IBL). Call before the scene is
 *  first built. */
export function setPbrSkybox(mat: Partial<PbrMaterialProps>): void {
    mat._skyboxMode = true;
    _registerPbrExt(pbrExt);
}
