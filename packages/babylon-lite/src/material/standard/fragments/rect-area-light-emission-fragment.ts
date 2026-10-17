import type { StdExt } from "../standard-flags.js";
import type { StandardSceneShaderContext } from "../standard-material.js";
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import { standardLightingFunction, _installStandardLightingArgumentsResolver, _installStandardLightingParametersResolver } from "../standard-template.js";
import { rectAreaStandardContext } from "./rect-area-light-fragment.js";
import { areaLightBindings } from "../../../light/area-light-wgsl.js";
import { areaLightEmissionBindings, areaLightEmissionWgsl } from "../../../light/area-light-emission-wgsl.js";
import { bindAreaLightLtc } from "../../../light/area-light-ltc.js";
import { bindAreaLightEmission } from "../../../light/area-light-emission.js";
import { wgsl } from "../../../shader/wgsl.js";

const RECT_AREA_STD_EMISSION = 1 << 29;
const RECT_AREA_STD_EMISSION_SCENE = 1 << 2;
const EMISSION_BRANCH = wgsl`
if (u32(L.vLightData.w) == 4u) {
let area = evaluateAreaLtc(N,viewDir,P,L,mat._0,lightIndex);
let color = L.vLightSpecular.rgb;
let fresnel = color * area.fresnel.x + (vec3<f32>(1.0) - color) * area.fresnel.y;
return array<vec3<f32>,2>(L.vLightDiffuse.rgb * area.diffuse,color * fresnel * area.specular);
}`;
let emissionLighting: string | undefined;

/** @internal Compare helper identity, never parse generated WGSL or pass branch-gating objects. */
export function installRectAreaEmissionStandard(): void {
    _installStandardLightingParametersResolver((extraCode) => (extraCode === EMISSION_BRANCH ? ", lightIndex: u32" : ""));
    emissionLighting ??= standardLightingFunction(EMISSION_BRANCH);
    _installStandardLightingArgumentsResolver((source) => (source === emissionLighting ? ", lightIndex" : ""));
}

/** @internal Replace only area emission; all punctual Standard lighting remains identical. */
export function rectAreaEmissionStandardContext(fog: ShaderFragment | null): StandardSceneShaderContext {
    installRectAreaEmissionStandard();
    const base = rectAreaStandardContext(fog);
    return {
        ...base,
        _features: base._features | RECT_AREA_STD_EMISSION_SCENE,
        _materialFeatures: RECT_AREA_STD_EMISSION,
        _lightingFunction: emissionLighting,
    };
}

/** @internal */
export const rectAreaEmissionStdExt: StdExt = {
    _id: "rect-area-emission",
    _phase: "mesh",
    _feature: RECT_AREA_STD_EMISSION,
    _frag() {
        return { _id: "rect-area-emission", _bindings: [...areaLightBindings(), ...areaLightEmissionBindings()], _helperFunctions: areaLightEmissionWgsl() };
    },
    _writeUbo(data, material) {
        data[22] = material.roughness ?? 0;
    },
    _bind(_material, entries, binding, _mesh, scene, disposers) {
        if (!scene) {
            throw new Error("RectAreaLight: emission bindings require their owning scene");
        }
        binding = bindAreaLightLtc(scene.surface.engine, entries, binding);
        return bindAreaLightEmission(scene._lighting?._bindingId, scene.surface.engine._device, entries, binding, disposers);
    },
};
