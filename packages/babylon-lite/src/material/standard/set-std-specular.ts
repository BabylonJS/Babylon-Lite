/** Specular-texture Standard material opt-in.
 *
 *  Statically imports the specular ext, so its WGSL, bind entries and feature detection
 *  only bundle when an app imports `setStandardSpecularTexture`. See `set-std-bump.ts`
 *  for the full rationale behind the internal backing field. */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { _registerStdExt } from "./standard-flags.js";
import { stdSpecularExt } from "./fragments/std-specular-fragment.js";

/** Set the specular texture on `mat`. Replaces `mat.specularColor`, and its alpha
 *  channel modulates glossiness. Reads `mat.specularCoordIndex` to select UV1 (0) or
 *  UV2 (1). Registers the specular extension globally (idempotent). Call before the
 *  scene is first built. */
export function setStandardSpecularTexture(mat: StandardMaterialProps, texture: Texture2D | null): void {
    mat._specularTexture = texture;
    _registerStdExt(stdSpecularExt);
}
