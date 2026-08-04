/** Per-texture UV-transform PBR material opt-in (KHR_texture_transform).
 *
 *  Statically imports the uv-transform ext, so the per-texture matrix/offset UBO slice
 *  and its writer bundle only when an app imports `setPbrUvTransform` (or the glTF
 *  slow-path loader, which calls this setter when any texture carries a transform).
 *  The renderable's shared chunk no longer carries the fragment's import specifier, and
 *  the `PBR2_HAS_UV_TRANSFORM` feature bit is now contributed by the ext's own `detect`
 *  rather than by the always-loaded base feature computation. */

import type { PbrMaterialProps } from "./pbr-material.js";
import { pbrExt } from "./fragments/uv-transform-fragment.js";
import { _registerPbrExt } from "./pbr-flags.js";

/** Enable per-texture UV transforms (scale / rotation / offset) on `mat`. The values are
 *  read from each texture's own `uScale`/`vScale`/`uAng`/`uOffset`/`vOffset` at UBO-write
 *  time, so this only has to be called once per material — animating those texture fields
 *  afterwards needs no further calls. Registers the uv-transform extension globally
 *  (idempotent). Call before the scene is first built. */
export function setPbrUvTransform(mat: Partial<PbrMaterialProps>): void {
    mat._hasUvTx = true;
    _registerPbrExt(pbrExt);
}
