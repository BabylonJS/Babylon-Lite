/** Lightmap-texture Standard material opt-in.
 *
 *  Statically imports the lightmap ext, so its WGSL, bind entries and feature detection
 *  only bundle when an app imports `setStandardLightmapTexture`. See `set-std-bump.ts`
 *  for the full rationale behind the internal backing field. */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { _registerStdExt } from "./standard-flags.js";
import { stdLightmapExt } from "./fragments/std-lightmap-fragment.js";

/** Set the lightmap texture on `mat`. Added to the final color by default, or
 *  multiplied into it when `mat.useLightmapAsShadowmap` is true. Reads
 *  `mat.lightmapLevel` for intensity and `mat.lightmapCoordIndex` to select UV1 (0) or
 *  UV2 (1, the BJS default). A texture with `uAng === Math.PI` is sampled V-flipped.
 *  Registers the lightmap extension globally (idempotent). Call before the scene is
 *  first built. */
export function setStandardLightmapTexture(mat: StandardMaterialProps, texture: Texture2D | null): void {
    mat._lightmapTexture = texture;
    _registerStdExt(stdLightmapExt);
}
