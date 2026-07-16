/**
 * Gamma-Albedo PBR Extension
 *
 * Carries the sRGB base-color decode template (pow(rgb, 2.2)) used when a material opts
 * into `gammaAlbedo`. The always-loaded base template weaves the returned WGSL into its
 * base-color decode slot via the `_gammaBaseColor` hook on the registered `pbrExt`, so the
 * decode string bundles only when an app imports `setPbrGammaAlbedo`.
 */

import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_GAMMA_ALBEDO } from "../pbr-flag-bits.js";
import { gammaBaseColor } from "../pbr-template-gamma.js";

/** @internal Gamma-albedo template hook, carried on the registered `pbrExt` so the
 *  always-loaded template can produce the sRGB base-color decode block WITHOUT a static
 *  import of the decode module — the function travels with the ext object, which only
 *  exists once gamma-albedo is registered (via {@link setPbrGammaAlbedo}). */
export interface GammaTemplateHooks {
    /** Produce the sRGB (pow 2.2) base-color decode block. */
    readonly _gammaBaseColor: (baseColorFactorRgb: string, baseColorFactorAlpha: string, vertexColorMod: string) => string;
}

/** Gamma-albedo extension. Contributes only the `PBR_HAS_GAMMA_ALBEDO` feature bit (via
 *  `detect`) plus the sRGB base-color decode template string (via {@link GammaTemplateHooks}).
 *  No fragment slot / UBO field / binding of its own. */
export const pbrExt: PbrExt & GammaTemplateHooks = {
    id: "gamma-albedo",
    phase: "fragment",
    _gammaBaseColor: gammaBaseColor,
    detect(mat) {
        return { f: (mat as { gammaAlbedo?: boolean }).gammaAlbedo ? PBR_HAS_GAMMA_ALBEDO : 0, f2: 0 };
    },
};
