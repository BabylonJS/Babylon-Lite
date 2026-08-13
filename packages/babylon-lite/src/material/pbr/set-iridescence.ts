/** Iridescence PBR material opt-in.
 *
 *  Statically imports the iridescence fragment's `pbrExt`; the fragment plus its wiring
 *  bundle only when an app imports `setPbrIridescence` (or the glTF
 *  `KHR_materials_iridescence` handler, which registers the same ext). No always-loaded
 *  `iridescence` scan or fragment import specifier remains in the renderable's shared chunk. */

import type { PbrMaterialProps, IridescenceProps } from "./pbr-material.js";
import { pbrExt } from "./fragments/iridescence-fragment.js";
import { _registerPbrExt } from "./pbr-flags.js";

/** Add a thin-film iridescence layer (soap-bubble / oil-slick hue shift) to `mat`.
 *  Registers the iridescence extension globally (idempotent). Call before the scene is
 *  first built. */
export function setPbrIridescence(mat: Partial<PbrMaterialProps>, iridescence: IridescenceProps): void {
    mat._iridescence = iridescence;
    _registerPbrExt(pbrExt);
}
