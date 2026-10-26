import type { SceneContext } from "../scene/scene.js";
import { hasAreaLightLtcOwner, prepareAreaLightLtc } from "./area-light-ltc.js";
import { _registerPbrExt, _registerPbrSceneHook } from "../material/pbr/pbr-flags.js";
import { _registerStdExt } from "../material/standard/standard-flags.js";
import { _installStandardSceneHooks } from "../material/standard/standard-group-builder.js";
import type { SceneLightingExtension } from "./lighting-extension.js";
import type { RectAreaLight } from "./rect-area-light.js";
import { MAX_LIGHTS } from "./types.js";

let prepareEmission: ((scene: SceneContext, lighting: SceneLightingExtension) => Promise<void>) | null = null;
/** @internal Preprocessing installs the textured feature; solid consumers eliminate this seam and its setter. */
export function _installRectAreaEmission(prepare: NonNullable<typeof prepareEmission>): void {
    prepareEmission = prepare;
}

async function prepareRectAreaPbr(scene: SceneContext): Promise<void> {
    if (hasAreaLightLtcOwner(scene)) {
        await enableRectAreaLights(scene);
    }
}

/** Prepare Babylon LTC tables and any assigned preprocessed emission images before scene registration/rebuild. */
export async function enableRectAreaLights(scene: SceneContext): Promise<void> {
    if (scene._z) {
        throw new Error("RectAreaLight: cannot enable lighting on a disposed scene");
    }
    if (!prepareEmission) {
        let packed = 0;
        for (const light of scene.lights) {
            if (light._writeLightUbo && packed++ < MAX_LIGHTS && light.lightType === "rectArea" && (light as RectAreaLight).emissionTexture !== null) {
                throw new Error("RectAreaLight: preprocess emissionTexture with processAreaLightTexture(engine, source) before enabling");
            }
        }
    }
    const [pbr, standard] = await Promise.all([
        import("../material/pbr/fragments/rect-area-light-fragment.js"),
        import("../material/standard/fragments/rect-area-light-fragment.js"),
        prepareAreaLightLtc(scene),
    ]);
    await prepareAreaLightLtc(scene);
    _registerPbrExt(pbr.rectAreaPbrExt);
    _registerPbrSceneHook(prepareRectAreaPbr);
    _registerStdExt(standard.rectAreaStdExt);
    _installStandardSceneHooks({
        prepare: async (current) => {
            await current._lighting?._prepare();
        },
        context: (current, fog) => current._lighting?._standard?.(fog),
    });
    const lighting: SceneLightingExtension = {
        _prepare: () => enableRectAreaLights(scene),
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
    if (prepareEmission) {
        await prepareEmission(scene, lighting);
    }
    if (scene._z) {
        throw new Error("RectAreaLight: scene was disposed while enabling lighting");
    }
    scene._lighting = lighting;
}
