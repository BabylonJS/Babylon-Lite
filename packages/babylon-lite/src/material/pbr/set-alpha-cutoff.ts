/** Alpha-test (alpha cutoff) PBR material opt-in.
 *
 *  Statically imports the alpha-test fragment's `pbrExt` (WGSL discard slot + feature-bit
 *  detection); it bundles only when an app imports `setPbrAlphaCutoff` or when the glTF
 *  loader hits a `MASK`-mode material and dynamically imports this module. No always-loaded
 *  `alphaCutOff` scan, hardcoded detect term, or fragment import specifier remains in the
 *  renderable's shared PBR chunk. */

import type { PbrMaterialProps } from "./pbr-material.js";
import { pbrExt } from "./fragments/alpha-test-fragment.js";
import { _registerPbrExt } from "./pbr-flags.js";

/** Enable alpha testing on `mat`: fragments whose base-color alpha (× material alpha) is
 *  below `alphaCutOff` are discarded. Registers the alpha-test extension globally
 *  (idempotent). Call before the scene is first built. */
export function setPbrAlphaCutoff(mat: Partial<PbrMaterialProps>, alphaCutOff: number): void {
    mat.alphaCutOff = alphaCutOff;
    _registerPbrExt(pbrExt);
}
