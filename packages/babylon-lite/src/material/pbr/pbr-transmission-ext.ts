/** Scene-level wiring for PBR transmission (refraction).
 *
 *  Unlike the other opt-in PBR features, transmission cannot be expressed as a plain
 *  `PbrExt` registration: it must also rewire the *scene* — retarget each render task's
 *  colour buffer to a linear offscreen, mark PBR materials linear, and append a trailing
 *  image-processing task. `setPbrTransmission` therefore registers `registerPbrTransmission`
 *  as a `PbrSceneHook`, which `buildPbrRenderables` drains with the scene it already holds.
 *
 *  Reached only through `set-transmission.ts` / `set-dispersion.ts` (or the glTF
 *  `KHR_materials_transmission` handler, which calls the same setters), so the refraction
 *  fragment, the frame-graph transmission code, and the gate below all stay out of the
 *  renderable's shared chunk. */

import type { SceneContext } from "../../scene/scene.js";
import type { EngineContext } from "../../engine/engine.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import { _t, enableSceneTransmission } from "../../frame-graph/transmission.js";
import { makeRefractionRttExt } from "./fragments/refraction-rtt-fragment.js";
import { _registerPbrExt } from "./pbr-flags.js";

let _dispersionSampleWgsl: string | undefined;

/** @internal Supply the per-RGB chromatic-dispersion sample WGSL. Called by
 *  `setPbrDispersion` so the 3-ray code chunk is bundled solely by dispersion scenes
 *  and never weighs on other transmission scenes. The string is injected into the
 *  refraction fragment (no shared module mutation). */
export function _setDispersionSampleWgsl(wgsl: string): void {
    _dispersionSampleWgsl = wgsl;
}

/** @internal `PbrSceneHook` that enables scene-texture transmission and registers the
 *  refraction ext. The hook registry is per-runtime, so this re-checks `meshes` and
 *  no-ops for groups without a transmissive surface — otherwise opting one material in
 *  would retarget every other group's render task for nothing. */
export function registerPbrTransmission(scene: SceneContext, engine: EngineContext, meshes: readonly Mesh[]): void {
    let hasTransmissionRefraction = false;
    for (let i = 0; i < meshes.length && !hasTransmissionRefraction; i++) {
        const mat = meshes[i]!.material as PbrMaterialProps | null;
        hasTransmissionRefraction = !!mat?._transmissive && (mat._subsurface?.refraction?.intensity ?? 0) > 0;
    }
    if (!hasTransmissionRefraction) {
        return;
    }
    scene._p?.(_t(scene, engine)) || enableSceneTransmission(scene, engine);
    _registerPbrExt(makeRefractionRttExt(_dispersionSampleWgsl));
}
