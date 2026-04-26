/** Global registry for the active light extension.
 *
 *  One light extension is active at a time. Lights register their extension
 *  lazily via `_registerExtension()` (a callback on `LightBaseInternal`),
 *  which is invoked by render pipelines when they discover the scene's lights.
 *
 *  The registry lives outside `material/pbr/` because the data the extension
 *  writes (`writeSceneUbo`) goes into material-orthogonal slots in the scene
 *  UBO that may be read by any material — not just PBR.
 */

import type { LightExtension } from "./types.js";

let _ext: LightExtension | null = null;

/** @internal */
export function _setLightExtension(ext: LightExtension): void {
    _ext = ext;
}

/** @internal */
export function _getLightExtension(): LightExtension | null {
    return _ext;
}
