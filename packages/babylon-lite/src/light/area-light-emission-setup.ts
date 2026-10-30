import type { SceneContext } from "../scene/scene.js";
import type { SceneLightingExtension } from "./lighting-extension.js";
import { _registerPbrExt } from "../material/pbr/pbr-flags.js";
import { _registerStdExt } from "../material/standard/standard-flags.js";
import { clearAreaLightEmission, prepareAreaLightEmission } from "./area-light-emission.js";
import {
    rectAreaEmissionPbrExt,
    installRectAreaEmissionPbr,
    rectAreaEmissionSingle,
    rectAreaEmissionMulti,
    RECT_AREA_PBR_EMISSION,
} from "../material/pbr/fragments/rect-area-light-emission-fragment.js";
import { rectAreaEmissionStdExt, installRectAreaEmissionStandard, rectAreaEmissionStandardContext } from "../material/standard/fragments/rect-area-light-emission-fragment.js";

export { clearAreaLightEmission };

/** @internal Loaded only when a processed emission image is actually assigned to a packed light. */
export async function prepareRectAreaEmission(scene: SceneContext, lighting: SceneLightingExtension): Promise<void> {
    const id = await prepareAreaLightEmission(scene);
    if (id === undefined) {
        return;
    }
    _registerPbrExt(rectAreaEmissionPbrExt);
    installRectAreaEmissionPbr();
    _registerStdExt(rectAreaEmissionStdExt);
    installRectAreaEmissionStandard();
    const features = lighting._pbrFeatures;
    lighting._bindingId = id;
    lighting._single = rectAreaEmissionSingle;
    lighting._multi = rectAreaEmissionMulti;
    lighting._pbrFeatures = (mesh) => (features?.(mesh) ?? 0) | RECT_AREA_PBR_EMISSION;
    lighting._standard = rectAreaEmissionStandardContext;
}
