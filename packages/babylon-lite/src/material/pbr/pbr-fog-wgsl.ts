/**
 * PBR fog receiver WGSL — the `calcFogFactor` helper plus the fog blend block.
 *
 * Dynamically imported by `pbr-renderable` ONLY when `scene.fog` is set, then threaded into the
 * PBR template as plain strings (the same pattern the ACES tonemap uses). This keeps every byte of
 * fog WGSL out of the bundles of PBR scenes that don't use fog — a static `import` of the helper
 * into `pbr-template` would defeat tree-shaking and inflate every PBR scene (see GUIDANCE §4c′).
 *
 * Parity notes (matches Babylon.js `pbr.fragment` exactly):
 *  - Fog is mixed into the LINEAR HDR colour BEFORE the tonemap / image-processing chain
 *    (BJS runs `fogFragment` before `pbrBlockImageProcessing`).
 *  - The fog FACTOR is linearised: `fog = toLinearSpace(fog)` = `pow(fog, 2.2)` (default approx sRGB).
 *  - The fog COLOUR is linearised too: BJS binds `vFogColor` with `linearSpace = true` for PBR
 *    (`BindFogParameters`), whereas the Standard material binds it raw. Lite stores one raw
 *    `vFogColor` in the scene UBO (correct for Standard, which has no trailing gamma), so the PBR
 *    path linearises it here with `pow(.., 2.2)`; after Lite's trailing gamma encode the fully
 *    fogged result returns to the authored fog colour (matching the background), exactly like BJS.
 *  - The runtime `vFogInfos.x > 0.0` guard lets `fogMode` toggle none/linear/exp/exp2 at runtime.
 */

import { WGSL_FOG } from "../../shader/wgsl-fog.js";

/** `calcFogFactor` + `E_FOG` helper WGSL (reads `scene.vFogInfos`). */
export const PBR_FOG_HELPER = WGSL_FOG;

/** Fog blend, emitted just before the PBR tonemap block (operates on the linear HDR `color`). */
export const PBR_FOG_BLOCK = `if(scene.vFogInfos.x>0.0){var fogFactor=calcFogFactor((scene.view*vec4<f32>(input.worldPos,1.0)).xyz);fogFactor=pow(fogFactor,2.2);color=mix(pow(scene.vFogColor.rgb,vec3<f32>(2.2)),color,fogFactor);}`;
