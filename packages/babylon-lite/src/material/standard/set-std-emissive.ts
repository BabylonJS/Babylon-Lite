/** Emissive-texture Standard material opt-in.
 *
 *  Statically imports the emissive ext, so its WGSL, bind entries and feature detection
 *  only bundle when an app imports `setStandardEmissiveTexture`. See `set-std-bump.ts`
 *  for the full rationale behind the internal backing field. */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { _registerStdExt } from "./standard-flags.js";
import { stdEmissiveExt } from "./fragments/std-emissive-fragment.js";

/** Set the emissive texture on `mat`; its sample is added to `mat.emissiveColor`. A
 *  depth-sampled texture (`_sampleType === "depth"`) automatically switches the binding
 *  to unfilterable-float with a non-filtering sampler. Registers the emissive extension
 *  globally (idempotent). Call before the scene is first built. */
export function setStandardEmissiveTexture(mat: StandardMaterialProps, texture: Texture2D | null): void {
    mat._emissiveTexture = texture;
    _registerStdExt(stdEmissiveExt);
}
