/** Opacity-texture Standard material opt-in.
 *
 *  Statically imports the opacity ext, so its WGSL, bind entries and feature detection
 *  only bundle when an app imports `setStandardOpacityTexture`. See `set-std-bump.ts`
 *  for the full rationale behind the internal backing field. */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { _registerStdExt } from "./standard-flags.js";
import { stdOpacityExt } from "./fragments/std-opacity-fragment.js";

/** Set the opacity texture on `mat`, which multiplies alpha. Reads `mat.opacityLevel`
 *  for intensity and `mat.opacityFromRGB` to derive opacity from RGB luminance instead
 *  of the `.a` channel. Registers the opacity extension globally (idempotent). Call
 *  before the scene is first built. */
export function setStandardOpacityTexture(mat: StandardMaterialProps, texture: Texture2D | null): void {
    mat._opacityTexture = texture;
    _registerStdExt(stdOpacityExt);
}
