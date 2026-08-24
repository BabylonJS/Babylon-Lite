/** Emissive-color PBR material opt-in.
 *
 *  Statically imports the emissive ext, so its material-UBO slice, WGSL slot and
 *  writer only bundle when an app imports `setPbrEmissive` (or a glTF asset with a
 *  non-default `emissiveFactor` is loaded). Only 9 of ~228 lab scenes use emissive,
 *  so the other ~219 now pay literally zero — no lazy chunk and no loader glue.
 *
 *  The backing field is `@internal _emissiveColor` rather than a public
 *  `emissiveColor` property on purpose: with a plain property, assigning it without
 *  also registering the ext would silently render black. Making it internal turns
 *  that mistake into a compile error and leaves this setter as the one way in. */

import type { PbrMaterialProps } from "./pbr-material.js";
import { pbrExt } from "./fragments/emissive-fragment.js";
import { _registerPbrExt } from "./pbr-flags.js";

/** Set the linear-RGB emissive color on `mat` (values may exceed 1.0 for HDR emissive,
 *  e.g. `KHR_materials_emissive_strength`). If the material also has an
 *  `emissiveTexture`, this color multiplies the sampled texel. The array is stored by
 *  reference and re-read on every UBO write, so animating it in place (index writes)
 *  needs no further calls. Registers the emissive extension globally (idempotent).
 *  Call before the scene is first built. */
export function setPbrEmissive(mat: Partial<PbrMaterialProps>, color: [number, number, number]): void {
    mat._emissiveColor = color;
    _registerPbrExt(pbrExt);
}
