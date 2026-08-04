/** Clearcoat PBR material opt-in.
 *
 *  Statically imports the clearcoat fragment's `pbrExt`, so the fragment plus its
 *  registration wiring are bundled only when an app imports `setPbrClearCoat` (or the
 *  glTF `KHR_materials_clearcoat` handler, which registers the same ext). Scenes that
 *  never opt in pay zero base-chunk bytes: there is no always-loaded `clearCoat` scan
 *  and no `import("./fragments/clearcoat-fragment.js")` specifier in the renderable's
 *  shared chunk. */

import type { PbrMaterialProps, ClearCoatProps } from "./pbr-material.js";
import { pbrExt } from "./fragments/clearcoat-fragment.js";
import { _registerPbrExt } from "./pbr-flags.js";

/** Add a glossy transparent clearcoat top layer (car paint, lacquer) to `mat`.
 *  Registers the clearcoat extension globally (idempotent) so the renderer detects and
 *  renders it. Call on the material returned by `createPbrMaterial` (or on the props
 *  before creating it), before the scene is first built. */
export function setPbrClearCoat(mat: Partial<PbrMaterialProps>, clearCoat: ClearCoatProps): void {
    mat._clearCoat = clearCoat;
    _registerPbrExt(pbrExt);
}
