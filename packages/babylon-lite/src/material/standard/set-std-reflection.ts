/** 2D reflection-texture Standard material opt-in.
 *
 *  Statically imports the reflection ext, so its WGSL, bind entries and feature
 *  detection only bundle when an app imports `setStandardReflectionTexture`. See
 *  `set-std-bump.ts` for the full rationale behind the internal backing field. */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { _registerStdExt } from "./standard-flags.js";
import { stdReflectionExt } from "./fragments/std-reflection-fragment.js";

/** Set the 2D spherical reflection texture on `mat`. Reads `mat.reflectionLevel` for
 *  intensity and `mat.reflectionCoordMode` (1 = spherical, 2 = planar). Registers the
 *  reflection extension globally (idempotent). Call before the scene is first built. */
export function setStandardReflectionTexture(mat: StandardMaterialProps, texture: Texture2D | null): void {
    mat._reflectionTexture = texture;
    _registerStdExt(stdReflectionExt);
}
