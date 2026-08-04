/** Transmission (refraction) PBR material opt-in.
 *
 *  Statically imports the transmission scene hook; the refraction fragment, the RTT
 *  scene-colour grab, and the frame-graph rewiring bundle only when an app imports
 *  `setPbrTransmission` (or the glTF `KHR_materials_transmission` handler, which calls
 *  this same setter). No always-loaded `_subsurface.refraction` scan or refraction
 *  import specifier remains in the renderable's shared chunk. */

import type { PbrMaterialProps, RefractionProps } from "./pbr-material.js";
import { registerPbrTransmission } from "./pbr-transmission-ext.js";
import { _registerPbrSceneHook } from "./pbr-flags.js";

/** Make `mat` a transmissive (refractive) surface: the renderer grabs the opaque scene
 *  colour mid-pass and the material refracts it, per `KHR_materials_transmission` +
 *  `_volume` + `_ior`. Registers the scene-level transmission hook globally (idempotent),
 *  which enables scene-texture transmission on every render task of any scene that
 *  actually contains a transmissive mesh. Call before the scene is first built.
 *
 *  Refraction only engages when `refraction.intensity > 0`. Pair with
 *  {@link setPbrSubsurface} for thickness/tint (volume absorption) and
 *  `setPbrDispersion` for chromatic dispersion. */
export function setPbrTransmission(mat: Partial<PbrMaterialProps>, refraction: RefractionProps): void {
    mat.transmissive = true;
    (mat._subsurface ??= {}).refraction = refraction;
    _registerPbrSceneHook(registerPbrTransmission);
}
