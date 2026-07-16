/** Unlit PBR material opt-in.
 *
 *  Statically imports the unlit fragment's `pbrExt`; the fragment plus its wiring bundle
 *  only when an app imports `setPbrUnlit` (or the glTF `KHR_materials_unlit` handler,
 *  which registers the same ext). No always-loaded `unlit` scan or fragment import
 *  specifier remains in the renderable's shared chunk. */

import type { PbrMaterialProps } from "./pbr-material.js";
import { pbrExt } from "./fragments/unlit-fragment.js";
import { _registerPbrExt } from "./pbr-flags.js";

/** Make `mat` unlit: the base color is output directly, bypassing all lighting, IBL,
 *  and tonemap (matches `KHR_materials_unlit`). Optional `unlitColor` is a linear-RGB tint
 *  applied to the base color. Registers the unlit extension globally (idempotent). Call
 *  before the scene is first built. */
export function setPbrUnlit(mat: Partial<PbrMaterialProps>, unlitColor?: [number, number, number]): void {
    mat.unlit = true;
    if (unlitColor) {
        mat.unlitColor = unlitColor;
    }
    _registerPbrExt(pbrExt);
}
