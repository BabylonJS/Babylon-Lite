import type { SceneContext } from "../scene/scene.js";
import { hasAreaLightLtcOwner, prepareAreaLightLtc } from "./area-light-ltc.js";
import { _registerPbrExt, _registerPbrSceneHook } from "../material/pbr/pbr-flags.js";
import { _registerStdExt } from "../material/standard/standard-flags.js";

async function prepareRectAreaPbr(scene: SceneContext): Promise<void> {
    if (hasAreaLightLtcOwner(scene)) {
        await prepareAreaLightLtc(scene);
    }
}

/** Prepare exact Babylon LTC tables and opt this scene into solid-color rectangular area lighting. */
export async function enableRectAreaLights(scene: SceneContext): Promise<void> {
    const [pbr, standard] = await Promise.all([
        import("../material/pbr/fragments/rect-area-light-fragment.js"),
        import("../material/standard/fragments/rect-area-light-fragment.js"),
        prepareAreaLightLtc(scene),
    ]);
    await prepareAreaLightLtc(scene);
    _registerPbrExt(pbr.rectAreaPbrExt);
    _registerPbrSceneHook(prepareRectAreaPbr);
    _registerStdExt(standard.rectAreaStdExt);
    scene._lighting = {
        _prepare: () => prepareAreaLightLtc(scene),
        _single: pbr.rectAreaSingleLightSource,
        _multi: pbr.rectAreaMultiLightSource,
        _pbrFeatures: (meshId) => pbr.rectAreaPbrFeatures(scene.lights, meshId),
        _standard: standard.rectAreaStandardContext,
        _validateNode: (usesLights) => {
            if (usesLights && scene.lights.some((light) => light.lightType === "rectArea")) {
                throw new Error("RectAreaLight: NodeMaterial lighting blocks are not supported yet; use PBR or Standard materials, or an unlit node graph");
            }
        },
    };
}
