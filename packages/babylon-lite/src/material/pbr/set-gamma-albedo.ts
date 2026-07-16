/** Gamma-albedo (sRGB base-color decode) PBR material opt-in.
 *
 *  Statically imports the gamma fragment's `pbrExt`; the sRGB base-color decode template
 *  bundles only when an app imports `setPbrGammaAlbedo`. No always-loaded `gammaAlbedo`
 *  scan or decode-module import specifier remains in the renderable's shared chunk. */

import type { PbrMaterialProps } from "./pbr-material.js";
import { pbrExt } from "./fragments/gamma-fragment.js";
import { _registerPbrExt } from "./pbr-flags.js";

/** Enable sRGB base-color decoding on `mat` (raises the albedo texture/factor to gamma 2.2
 *  before lighting). Registers the gamma-albedo extension globally (idempotent). Call
 *  before the scene is first built. */
export function setPbrGammaAlbedo(mat: Partial<PbrMaterialProps>): void {
    (mat as { gammaAlbedo?: boolean }).gammaAlbedo = true;
    _registerPbrExt(pbrExt);
}
