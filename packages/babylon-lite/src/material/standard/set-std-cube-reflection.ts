/** Cube reflection-texture Standard material opt-in.
 *
 *  Statically imports the cube-reflection ext, so its WGSL, bind entries and feature
 *  detection only bundle when an app imports `setStandardReflectionCubeTexture`. See
 *  `set-std-bump.ts` for the full rationale behind the internal backing field. */

import type { StandardMaterialProps } from "./standard-material.js";
import type { CubeTexture } from "../../texture/cube-texture.js";
import { _registerStdExt } from "./standard-flags.js";
import { stdCubeReflectionExt } from "./fragments/std-cube-reflection-fragment.js";

/** Set the cube reflection texture on `mat` (environment reflection sampled along the
 *  view-reflection vector). Reads `mat.reflectionLevel` for intensity. Registers the
 *  cube-reflection extension globally (idempotent). Call before the scene is first
 *  built.
 *
 *  Obtain `texture` from `loadCubeTexture()`:
 *
 * ```ts
 * setStandardReflectionCubeTexture(mat, await loadCubeTexture(engine, "/env/sky"));
 * ```
 */
export function setStandardReflectionCubeTexture(mat: StandardMaterialProps, texture: CubeTexture | null): void {
    mat._reflectionCubeTexture = texture;
    _registerStdExt(stdCubeReflectionExt);
}
