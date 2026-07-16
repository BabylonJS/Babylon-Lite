/** Sheen PBR material opt-in.
 *
 *  Statically imports the sheen fragment's `pbrExt`; the fragment plus its wiring bundle
 *  only when an app imports `setPbrSheen` (or the glTF `KHR_materials_sheen` handler,
 *  which registers the same ext). No always-loaded `sheen` scan or fragment import
 *  specifier remains in the renderable's shared chunk. */

import type { PbrMaterialProps, SheenProps } from "./pbr-material.js";
import { pbrExt } from "./fragments/sheen-fragment.js";
import { _registerPbrExt } from "./pbr-flags.js";

/** Add a soft velvet-like sheen layer (fabric, cloth) to `mat`. Registers the sheen
 *  extension globally (idempotent). Call before the scene is first built. */
export function setPbrSheen(mat: Partial<PbrMaterialProps>, sheen: SheenProps): void {
    mat.sheen = sheen;
    _registerPbrExt(pbrExt);
}
