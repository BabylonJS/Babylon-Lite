/** Subsurface (translucency) PBR material opt-in.
 *
 *  Statically imports the subsurface fragment's `pbrExt`; the fragment plus its wiring
 *  bundle only when an app imports `setPbrSubsurface` (or the glTF
 *  `KHR_materials_diffuse_transmission` handler, which registers the same ext). No
 *  always-loaded `subsurface` scan or fragment import specifier remains in the
 *  renderable's shared chunk. Refraction/transmission is a separate opt-in path. */

import type { PbrMaterialProps, SubSurfaceProps } from "./pbr-material.js";
import { pbrExt } from "./fragments/subsurface-fragment.js";
import { _registerPbrExt } from "./pbr-flags.js";

/** Add subsurface translucency (thin-surface diffuse transmission) to `mat`. The
 *  fragment only renders when `subsurface.translucency` is present. Registers the
 *  subsurface extension globally (idempotent). Call before the scene is first built. */
export function setPbrSubsurface(mat: Partial<PbrMaterialProps>, subsurface: SubSurfaceProps): void {
    mat.subsurface = subsurface;
    _registerPbrExt(pbrExt);
}
