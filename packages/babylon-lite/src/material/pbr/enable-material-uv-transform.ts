/** Per-texture UV-transform PBR material opt-in (KHR_texture_transform).
 *
 *  Statically imports the uv-transform ext, so the per-texture matrix/offset UBO slice
 *  and its writer bundle only when an app imports `enableMaterialUvTransform` (or the glTF
 *  slow-path loader, which calls it when any texture carries a transform).
 *  The renderable's shared chunk no longer carries the fragment's import specifier, and
 *  the `PBR2_HAS_UV_TRANSFORM` feature bit is now contributed by the ext's own `detect`
 *  rather than by the always-loaded base feature computation. */

import type { PbrMaterialProps } from "./pbr-material.js";
import { pbrExt } from "./fragments/uv-transform-fragment.js";
import { _registerPbrExt } from "./pbr-flags.js";

/** Opt a PBR material into the per-texture UV transform machinery ahead of need.
 *
 *  Call this before the first build for hand-created materials that use or animate
 *  `uScale`/`vScale`/`uAng`/`uOffset`/`vOffset`. The values are read from each texture's
 *  own fields at UBO-write time, so this only has to be called once per material —
 *  animating those texture fields afterwards needs no further calls, just pair later
 *  mutations with `markMaterialUboDirty`. glTF materials are enabled automatically by the
 *  loader. Registers the uv-transform extension globally (idempotent).
 *
 *  Returns `true` when the material has not been built yet, so the flag simply rides the first
 *  build. Returns `false` when the material's feature set was already compiled: the flag is set,
 *  but applying it needs `rebuildMaterial(scene, material)` — the designed path for post-build
 *  feature changes — or nothing visible happens. */
export function enableMaterialUvTransform(material: Partial<PbrMaterialProps>): boolean {
    material._hasUvTx = true;
    _registerPbrExt(pbrExt);
    return (material as { _renderFeatures?: unknown })._renderFeatures === undefined;
}
