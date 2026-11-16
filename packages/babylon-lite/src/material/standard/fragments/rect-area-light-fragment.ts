import type { StdExt } from "../standard-flags.js";
import { STD_SCENE_FOG, _installStandardLightingSource } from "../standard-flags.js";
import type { StandardSceneShaderContext } from "../standard-material.js";
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import { standardLightingFunction } from "../standard-template.js";
import { areaLightBindings, AREA_LIGHT_WGSL } from "../../../light/area-light-wgsl.js";
import { bindAreaLightLtc } from "../../../light/area-light-ltc.js";
import { wgsl } from "../../../shader/wgsl.js";

const RECT_AREA_STD = 1 << 28;
const RECT_AREA_STD_SCENE = 1 << 1;

/** @internal Scene context carries lighting code and the extension's material feature bit. */
export function rectAreaStandardContext(fog: ShaderFragment | null): StandardSceneShaderContext {
    _installStandardLightingSource();
    return {
        _features: RECT_AREA_STD_SCENE | (fog ? STD_SCENE_FOG : 0),
        _fragments: fog ? [fog] : [],
        _materialFeatures: RECT_AREA_STD,
        _lightingFunction: standardLightingFunction(wgsl`
if (u32(L.vLightData.w) == 4u) {
let area = evaluateAreaLtc(N,viewDir,P,L,mat._0);
let color = L.vLightSpecular.rgb;
let fresnel = color * area.fresnel.x + (vec3<f32>(1.0) - color) * area.fresnel.y;
return array<vec3<f32>,2>(L.vLightDiffuse.rgb * area.diffuse,color * fresnel * area.specular);
}
`),
    };
}

/** @internal Registered only by the explicit area-light enabler. */
export const rectAreaStdExt: StdExt = {
    _id: "rect-area-light",
    _phase: "mesh",
    _feature: RECT_AREA_STD,
    _frag() {
        return { _id: "rect-area-light", _bindings: areaLightBindings(), _helperFunctions: AREA_LIGHT_WGSL };
    },
    _writeUbo(data, material) {
        data[22] = material.roughness ?? 0;
    },
    _bind(_material, entries, binding, _mesh, scene) {
        if (!scene) {
            throw new Error("RectAreaLight: Standard bindings require their owning scene");
        }
        return bindAreaLightLtc(scene.surface.engine, entries, binding);
    },
};
