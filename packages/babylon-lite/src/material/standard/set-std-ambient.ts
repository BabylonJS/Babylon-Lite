/** Ambient/occlusion-texture Standard material opt-in.
 *
 *  Statically imports the ambient ext, so its WGSL, bind entries and feature detection
 *  only bundle when an app imports `setStandardAmbientTexture`. See `set-std-bump.ts`
 *  for the full rationale behind the internal backing field. */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { _registerStdExt } from "./standard-flags.js";
import { stdAmbientExt } from "./fragments/std-ambient-fragment.js";

/** Set the ambient/occlusion texture on `mat`, which multiplies the final diffuse
 *  contribution. Reads `mat.ambientTexLevel` for intensity and `mat.ambientCoordIndex`
 *  to select UV1 (0) or UV2 (1). Registers the ambient extension globally (idempotent).
 *  Call before the scene is first built. */
export function setStandardAmbientTexture(mat: StandardMaterialProps, texture: Texture2D | null): void {
    mat._ambientTexture = texture;
    _registerStdExt(stdAmbientExt);
}
