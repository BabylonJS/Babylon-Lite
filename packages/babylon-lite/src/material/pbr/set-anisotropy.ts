/** Anisotropy PBR material opt-in.
 *
 *  Statically imports the anisotropy fragment's `pbrExt`; the fragment (including its
 *  BRDF / tangent-frame template strings and feature-bit detection) bundles only when an
 *  app imports `setPbrAnisotropy` (or the glTF `KHR_materials_anisotropy` handler, which
 *  registers the same ext). No always-loaded `anisotropy` scan or fragment import
 *  specifier remains in the renderable's shared chunk. */

import type { PbrMaterialProps, AnisotropyProps } from "./pbr-material.js";
import { pbrExt } from "./fragments/anisotropy-fragment.js";
import { _registerPbrExt } from "./pbr-flags.js";

/** Add anisotropy (direction-dependent specular highlight stretching) to `mat`. Registers
 *  the anisotropy extension globally (idempotent). Call before the scene is first built. */
export function setPbrAnisotropy(mat: Partial<PbrMaterialProps>, anisotropy: AnisotropyProps): void {
    mat.anisotropy = anisotropy;
    _registerPbrExt(pbrExt);
}
