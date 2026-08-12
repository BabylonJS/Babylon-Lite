/** Chromatic-dispersion PBR material opt-in (KHR_materials_dispersion).
 *
 *  Split from `setPbrTransmission` so the 3-ray per-RGB sample WGSL is bundled solely by
 *  scenes that actually disperse — plain transmission scenes pay zero bytes for it. This
 *  replaces the scene-wide `refr.dispersion` scan + conditional dispersion-WGSL import
 *  that used to run on every transmission build. */

import type { PbrMaterialProps } from "./pbr-material.js";
import { DISPERSION_SAMPLE_WGSL } from "./fragments/refraction-dispersion-wgsl.js";
import { _setDispersionSampleWgsl, registerPbrTransmission } from "./pbr-transmission-ext.js";
import { _registerPbrSceneHook } from "./pbr-flags.js";

/** Add chromatic dispersion to `mat`'s refraction: the refracted ray is split into
 *  per-RGB indices of refraction. `dispersion` is Babylon's empirical dispersion
 *  strength (glTF's `KHR_materials_dispersion.dispersion` maps to `20 / dispersion`).
 *  Requires transmission and volume — use with {@link setPbrTransmission} and a
 *  `subsurface.thickness`. Call before the scene is first built. */
export function setPbrDispersion(mat: Partial<PbrMaterialProps>, dispersion: number): void {
    ((mat._subsurface ??= {}).refraction ??= {}).dispersion = dispersion;
    _setDispersionSampleWgsl(DISPERSION_SAMPLE_WGSL);
    _registerPbrSceneHook(registerPbrTransmission);
}
