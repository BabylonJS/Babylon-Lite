import type { PbrExt } from "../pbr-flags.js";
import { PBR2_ESM_SHADOW_OUTPUT, PBR2_NO_COLOR_OUTPUT } from "../pbr-flag-bits.js";
import type { MultiLightShaderSource, SingleLightShaderSource } from "../../../light/lighting-extension.js";
import { bindAreaLightLtc } from "../../../light/area-light-ltc.js";
import { areaLightBindings, AREA_LIGHT_WGSL } from "../../../light/area-light-wgsl.js";
import { COMPUTE_PBR_LIGHT, getMultiLightLoop, MULTI_LIGHT_STRUCTS } from "./multilight-wgsl.js";
import { wgsl } from "../../../shader/wgsl.js";
import type { LightBase } from "../../../light/types.js";
import { MAX_LIGHTS } from "../../../light/types.js";
import { lightAffectsMesh } from "../../../render/mesh-light-selection.js";
import type { Mesh } from "../../../mesh/mesh.js";

/** @internal Scene-feature bit, distinct from material feature bits. */
export const RECT_AREA_PBR_SCENE = 1 << 6;
/** @internal A selected area light, not merely an enabled scene, requires polygonal layered BRDFs. */
export const RECT_AREA_PBR_SELECTED = 1 << 7;

/** @internal Mirror the actual packed mesh light selection without allocating an index array. */
export function rectAreaPbrFeatures(lights: readonly LightBase[], mesh: Mesh): number {
    let packed = 0;
    for (const light of lights) {
        if (packed >= MAX_LIGHTS) {
            break;
        }
        if (!light._writeLightUbo) {
            continue;
        }
        if (light.lightType === "rectArea" && lightAffectsMesh(light, mesh)) {
            return RECT_AREA_PBR_SCENE | RECT_AREA_PBR_SELECTED;
        }
        packed++;
    }
    return RECT_AREA_PBR_SCENE;
}

function areaPbrContribution(evaluation: string): string {
    return wgsl`
let areaEntry = lights.lights[lightIndex];
let area = ${evaluation};
let areaColor = areaEntry.vLightSpecular.rgb;
let areaFresnel = colorF0 * areaColor * area.fresnel.x + (vec3<f32>(1.0) - areaColor) * area.fresnel.y * colorF90;
directDiffuse += surfaceAlbedo * areaEntry.vLightDiffuse.rgb * area.diffuse * material.directIntensity;
directSpecular += areaColor * areaFresnel * area.specular * material.directIntensity;
`;
}

const AREA_PBR_WRAPPER = wgsl`
fn computeRectPbrLight(entry: LightEntry, N: vec3<f32>, P: vec3<f32>, falloff: f32) -> PbrLightResult {
if (u32(entry.vLightData.w) == 4u) {
return PbrLightResult(N,0.0,0.0,vec3<f32>(0.0),vec3<f32>(0.0),false);
}
return computePbrLight(entry,N,P,falloff);
}
`;

/** @internal Keep the existing punctual light loop; the area branch consumes only area entries. */
export function rectAreaMultiLightSource(evaluation = "evaluateAreaLtc(N,V,input.worldPos,areaEntry,roughness)"): MultiLightShaderSource {
    return {
        _helpers: MULTI_LIGHT_STRUCTS() + COMPUTE_PBR_LIGHT + AREA_PBR_WRAPPER,
        _loop: getMultiLightLoop(
            wgsl`
if (u32(lights.lights[lightIndex].vLightData.w) == 4u) {
${areaPbrContribution(evaluation)}
continue;
}`,
            "computeRectPbrLight"
        ),
    };
}

/** @internal A true selected-single-area path, independent of the punctual single-light fallback. */
export function rectAreaSingleLightSource(type: string, evaluation = "evaluateAreaLtc(N,V,input.worldPos,areaEntry,roughness)"): SingleLightShaderSource | undefined {
    if (type !== "rectArea") {
        return undefined;
    }
    return {
        SINGLE_LIGHT_STRUCTS: MULTI_LIGHT_STRUCTS(),
        getSingleLightBlock: () => wgsl`
var directDiffuse = vec3<f32>(0.0);
var directSpecular = vec3<f32>(0.0);
let lightIndex = mli(0u);
${areaPbrContribution(evaluation)}
let L = N;
let NdotL = 0.0;
let lightColor = areaEntry.vLightSpecular.rgb;
let lightAtten = 1.0;
let H = normalize(V + L);
let NdotH = clamp(dot(N,H),0.0000001,1.0);
let VdotH = clamp(dot(V,H),0.0,1.0);
/*AD*/`,
    };
}

/** @internal Explicitly registered by enableRectAreaLights; no import-time registration. */
export const rectAreaPbrExt: PbrExt = {
    id: "rect-area-light",
    phase: "fragment",
    frag(ctx) {
        if (!((ctx._sceneFeatures ?? 0) & RECT_AREA_PBR_SCENE) || ctx._lightMode === 0 || ctx._features2 & (PBR2_NO_COLOR_OUTPUT | PBR2_ESM_SHADOW_OUTPUT)) {
            return null;
        }
        if ((ctx._sceneFeatures ?? 0) & (1 << 8)) {
            return null;
        }
        // These optional layered BRDFs require their own polygon integration, not a punctual surrogate.
        if ((ctx._sceneFeatures ?? 0) & RECT_AREA_PBR_SELECTED && (ctx._features & ((1 << 20) | (1 << 22) | (1 << 26) | (1 << 27)) || ctx._features2 & (7 << 17))) {
            throw new Error("RectAreaLight: layered PBR direct lighting (clearcoat, sheen, anisotropy, subsurface, iridescence) is not supported yet");
        }
        return { _id: "rect-area-light", _bindings: areaLightBindings(), _helperFunctions: AREA_LIGHT_WGSL };
    },
    bind(ctx, entries, binding) {
        return bindAreaLightLtc(ctx._engine, entries, binding);
    },
};
